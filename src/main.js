/*
 * Crossfade DJ — диджейские переходы между треками для Яндекс Музыки (аддон PulseSync, тип "script").
 * Автор: Pronyfka. Лицензия MIT.
 *
 * Громкость сводит встроенный движок кроссфейда Яндекса. Аддон:
 *  1) анализирует текущий и следующий трек: BPM, сетка тактов, энергия и бас по тактам,
 *     дропы/припевы и их концы;
 *  2) планирует переход: выход и вход на началах тактов, длина в целых тактах,
 *     конец сведения — на конце дропа старого и на дропе нового трека;
 *  3) подставляет точки движку (через getCrossParams пары трека) и заранее готовит следующий трек;
 *  4) подгоняет темп: темпы встречаются посередине, доли держит ПИ-регулятор;
 *  5) добавляет эффекты на Web Audio: обмен басов, фильтры, «вокал поверх», эхо в такт.
 */
(function () {
    'use strict';
    const VERSION = '1.0.0';
    const TAG = '[Crossfade DJ]';
    const LS_SETTINGS = 'xfdj:settings';
    const LS_ANALYSIS = 'xfdj:a:';
    const LS_INDEX = 'xfdj:index';

    // Если уже загружена другая копия — останавливаем её
    try { window.__xfdj && window.__xfdj.dispose && window.__xfdj.dispose(); } catch (_) {}

    const startedAt = Date.now();
    const clock = () => ((Date.now() - startedAt) / 1000).toFixed(1);

    // ---------- настройки ----------
    // Основные настройки (подобраны на живых переходах) — ставятся при первой установке,
    // к ним же возвращают «Стандарт» и «Сбросить»
    const BASE_FX = { swapBeats: 0, iso: 0.3, filter: 0.9, openIn: 1, echo: 0.75, echoTail: 0.6, voxLevel: 1.6, voxDip: -10, thin: 1, lowKill: -32 };
    const BASE_SETTINGS = { mixBars: 'auto', style: 'smooth', tempoSync: true, maxStretch: 0.06, toDrop: true, fx: 'auto' };
    const DEFAULT_SETTINGS = Object.assign({ enabled: true, panel: 'full', preset: 'std' }, BASE_SETTINGS, { fxp: Object.assign({}, BASE_FX) });
    function loadSettings() {
        try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); }
        catch (_) { return Object.assign({}, DEFAULT_SETTINGS); }
    }
    function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S.settings)); } catch (_) {} }

    const S = {
        settings: loadSettings(),
        log: [], errors: [],
        analyses: new Map(),     // id -> анализ | {ok:false, reason}
        pending: new Map(),      // id -> Promise
        params: new Map(),       // id -> { in: {...}, out: {...} }
        plan: null,              // текущий план {curId, nextId, ...}
        planKey: null,
        rearmPending: false,
        crossStartAt: 0,
        sync: null,              // состояние подгонки темпа
        lastSync: null,          // итог последнего перехода
        engineOrigEnabled: null,
        patchedProtos: new WeakSet(),
        hookedEngines: new WeakSet(),
        provider: null,
        status: 'запуск…',
        alive: true,
        fxScanAt: 0,
        entryAt: new Map(),      // id -> с какого места трек зазвучал сам (после нашего перехода)
        lastFx: null,
    };

    function log(msg) {
        S.log.push(`${clock()}s ${msg}`);
        if (S.log.length > 200) S.log.shift();
        try { console.log(TAG, msg); } catch (_) {}
        renderSoon();
    }
    function err(where, e) {
        const m = `${clock()}s ${where}: ${e && e.message ? e.message : String(e)}`;
        S.errors.push(m);
        if (S.errors.length > 60) S.errors.shift();
        try { console.warn(TAG, m, e); } catch (_) {}
        renderSoon();
    }
    const val = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : o);

    // Эффекты: перехватываем вывод звука как можно раньше
    const FX = XFEffects.create({ log, err });
    FX.install();
    const fmt = (s) => {
        if (!Number.isFinite(s)) return '—';
        const m = Math.floor(s / 60), r = Math.floor(s % 60);
        return `${m}:${String(r).padStart(2, '0')}`;
    };

    // ---------- доступ к плееру ----------
    function playback() { return (window.pulsesyncApi && window.pulsesyncApi.playerInstance) || window.__pulseSyncPendingPlayerInstance || null; }
    function engine() {
        const st = playback() && playback().state;
        if (!st) return null;
        const list = [val(st.currentMediaPlayer), ...Object.values(val(st.mediaPlayersStore) || {})];
        return list.find(m => m && typeof m.forceStopCrossfade === 'function' && m.isEnabled && 'value' in m.isEnabled && typeof m.startTimeTracking === 'function') || null;
    }
    function pairs() {
        const qs = playback() && playback().state && playback().state.queueState;
        return qs ? { cur: val(qs.currentEntity) || null, next: val(qs.nextEntity) || null } : { cur: null, next: null };
    }
    const metaOf = (pair) => { try { return pair.entity.data.meta; } catch (_) { return null; } };
    const idOf = (pair) => { const m = metaOf(pair); return m && m.id != null ? String(m.id) : null; };
    const titleOf = (pair) => {
        const m = metaOf(pair); if (!m) return '—';
        const ar = Array.isArray(m.artists) ? m.artists.map(a => a && a.name).filter(Boolean).join(', ') : '';
        return `${m.title || '?'}${ar ? ' — ' + ar : ''}`;
    };
    const durOf = (pair, an) => {
        const m = metaOf(pair);
        if (m && Number.isFinite(m.durationMs) && m.durationMs > 0) return m.durationMs / 1000;
        return an && an.duration;
    };
    function currentAudio() {
        const e = engine();
        return e ? val(e.currentAudioElement) : null;
    }

    // ---------- получение аудио трека ----------
    function findProvider() {
        if (S.provider) return S.provider;
        // Быстрый путь: медиаплееры движка держат ссылку на загрузчик
        try {
            const e = engine();
            for (const mp of [e && e.firstMediaPlayer, e && e.secondMediaPlayer, e && e.currentMediaPlayer]) {
                const pr = mp && mp.mediaProvider;
                if (pr && (typeof pr.getFileInfoFromResource === 'function' || typeof pr.getMediaSource === 'function')) {
                    S.provider = pr; log('нашёл загрузчик файлов (mediaProvider)'); return pr;
                }
            }
        } catch (_) {}
        const root = playback();
        if (!root) return null;
        const seen = new WeakSet();
        const queue = [[root, 0]];
        let visited = 0;
        while (queue.length && visited < 40000) {
            const [o, d] = queue.shift();
            if (!o || typeof o !== 'object' || seen.has(o)) continue;
            seen.add(o); visited++;
            if (typeof Node !== 'undefined' && o instanceof Node) continue;
            if (ArrayBuffer.isView(o)) continue;
            try {
                if (typeof o.getFileInfoFromResource === 'function' || (typeof o.getMediaSource === 'function' && typeof o.createMediaSource === 'function')) {
                    S.provider = o; log(`нашёл загрузчик файлов (обход ${visited})`); return o;
                }
            } catch (_) {}
            if (d >= 9) continue;
            let keys; try { keys = Object.keys(o); } catch (_) { continue; }
            for (const k of keys) {
                let v; try { v = o[k]; } catch (_) { continue; }
                if (v && typeof v === 'object') queue.push([v, d + 1]);
            }
        }
        return null;
    }

    async function fileInfoFor(pair) {
        const entity = pair.entity;
        const ready = entity && entity.mediaSourceData && entity.mediaSourceData.data;
        if (ready && (ready.url || (ready.urls && ready.urls.length))) return ready;
        // Текущий трек уже играет — берём ссылку прямо из <audio>
        const { cur } = pairs();
        const el = currentAudio();
        if (cur && idOf(cur) === idOf(pair) && el && /^(https?:|blob:)/.test(el.currentSrc || '')) {
            return { url: el.currentSrc, transport: 'raw', codec: 'element', fromElement: true };
        }
        const provider = findProvider();
        if (!provider) throw new Error('не найден загрузчик файлов плеера');
        if (typeof provider.getFileInfoFromResource !== 'function') {
            const ms = await provider.getMediaSource({ entity });
            const info = ms && ms.data;
            if (info && (info.url || (info.urls && info.urls.length))) return info;
            throw new Error('getMediaSource не вернул ссылку');
        }
        const codecs = Array.isArray(provider.codecs) && provider.codecs.length ? provider.codecs : ['aac', 'he-aac', 'mp3'];
        let lastErr;
        for (const quality of ['nq', 'lq', 'hq']) {
            try {
                const res = await provider.getFileInfoFromResource({ trackId: idOf(pair), quality, codecs, transports: ['raw'] });
                const info = res && (res.downloadInfo || res);
                if (info && !info.error && (info.url || (info.urls && info.urls.length))) return info;
                lastErr = new Error('пустой ответ get-file-info');
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('не удалось получить ссылку на файл');
    }

    async function decrypt(buf, hexKey) {
        const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g).map(h => parseInt(h, 16)));
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']);
        return crypto.subtle.decrypt({ name: 'AES-CTR', counter: new Uint8Array(16), length: 128 }, key, buf);
    }

    async function loadMono(pair) {
        const info = await fileInfoFor(pair);
        const url = (info.urls && info.urls[0]) || info.url;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`скачивание: HTTP ${resp.status}`);
        let buf = await resp.arrayBuffer();
        if (info.transport === 'encraw' && info.key) buf = await decrypt(buf, info.key);
        const bytes = buf.byteLength;   // decodeAudioData «забирает» буфер, запоминаем размер заранее
        const ctx = new OfflineAudioContext(1, 2, 22050);
        const audio = await ctx.decodeAudioData(buf);
        const n = audio.length, ch = audio.numberOfChannels;
        const mono = new Float32Array(n);
        for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
        return { mono, sr: audio.sampleRate, codec: info.codec, bytes };
    }

    // ---------- кэш анализа ----------
    function cacheGet(id) {
        if (S.analyses.has(id)) return S.analyses.get(id);
        try {
            const raw = localStorage.getItem(LS_ANALYSIS + id);
            if (raw) { const a = JSON.parse(raw); if (a && a.version === 3) { S.analyses.set(id, a); return a; } }
        } catch (_) {}
        return null;
    }
    // Кэш анализа в localStorage (оно общее с самой Яндекс Музыкой — держим его маленьким)
    const CACHE_MAX = 150;
    function cacheIndex() { try { const v = JSON.parse(localStorage.getItem(LS_INDEX) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
    function cachePut(id, a) {
        S.analyses.set(id, a);
        if (!a.ok) return;
        const idx = cacheIndex().filter(x => x !== id);
        idx.push(id);
        while (idx.length > CACHE_MAX) { try { localStorage.removeItem(LS_ANALYSIS + idx.shift()); } catch (_) {} }
        const json = JSON.stringify(a);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                localStorage.setItem(LS_ANALYSIS + id, json);
                localStorage.setItem(LS_INDEX, JSON.stringify(idx));
                return;
            } catch (_) {
                // Места нет — освобождаем треть самых старых записей и пробуем ещё раз
                const drop = Math.max(1, Math.floor(idx.length / 3));
                for (const old of idx.splice(0, Math.min(drop, idx.length - 1))) { try { localStorage.removeItem(LS_ANALYSIS + old); } catch (_) {} }
            }
        }
    }
    // Записи прошлых версий анализа больше не читаются — убираем их один раз при запуске
    function cacheCleanup() {
        try {
            const idx = cacheIndex(), keep = [];
            for (const id of idx) {
                let ok = false;
                try { const a = JSON.parse(localStorage.getItem(LS_ANALYSIS + id) || 'null'); ok = !!(a && a.version === 3); } catch (_) {}
                if (ok) keep.push(id); else localStorage.removeItem(LS_ANALYSIS + id);
            }
            while (keep.length > CACHE_MAX) localStorage.removeItem(LS_ANALYSIS + keep.shift());
            if (keep.length !== idx.length) localStorage.setItem(LS_INDEX, JSON.stringify(keep));
        } catch (_) {}
    }
    cacheCleanup();

    let analyzeChain = Promise.resolve();
    function ensureAnalysis(pair) {
        const id = idOf(pair);
        if (!id) return null;
        const cached = cacheGet(id);
        if (S.pending.has(id)) return cached;
        // Неудачу повторяем: через 8 с, до 5 попыток
        if (cached && (cached.ok || !cached.retryAt || Date.now() < cached.retryAt || cached.attempts >= 5)) return cached;
        const attempts = cached && !cached.ok ? (cached.attempts || 1) + 1 : 1;
        const title = titleOf(pair);
        const p = analyzeChain = analyzeChain.then(async () => {
            if (!S.alive) return;
            const t0 = Date.now();
            S.status = `анализ: ${title}`;
            renderSoon();
            try {
                const { mono, sr, codec, bytes } = await loadMono(pair);
                // Даём интерфейсу подышать перед тяжёлым расчётом
                await new Promise(r => setTimeout(r, 30));
                const a = XFAnalysis.analyze(mono, sr);
                a.codec = codec; a.kb = Math.round(bytes / 1024); a.totalMs = Date.now() - t0;
                cachePut(id, a);
                log(a.ok ? `анализ «${title}»: ${a.bpm} BPM, уверенность ${a.confidence}, ${a.totalMs} мс` : `анализ «${title}»: ${a.reason}`);
            } catch (e) {
                S.analyses.set(id, { ok: false, reason: e.message || String(e), attempts, retryAt: Date.now() + 8000 });
                err(`анализ «${title}» (попытка ${attempts})`, e);
            } finally {
                S.pending.delete(id);
                S.status = 'готов';
                tick();
            }
        });
        S.pending.set(id, p);
        return null;
    }

    // ---------- подмена точек перехода ----------
    function patchPairProto(pair) {
        const proto = pair && Object.getPrototypeOf(pair);
        if (!proto || S.patchedProtos.has(proto) || typeof proto.getCrossParams !== 'function') return;
        if (proto.__xfdjPatched) { S.patchedProtos.add(proto); return; }
        const origGet = proto.getCrossParams, origCan = proto.canBeCrossedWith;
        proto.getCrossParams = function () {
            const base = origGet.apply(this, arguments);
            try {
                if (!window.__xfdj || !window.__xfdj.active()) return base;
                const id = idOf(this);
                const own = id && window.__xfdj.paramsFor(id);
                if (!own) return base;
                const dur = durOf(this, null) || 0;
                const b = base && typeof base === 'object' ? base : null;
                const out = {
                    inStart: own.in ? own.in.inStart : (b ? b.inStart : 0),
                    inStop: own.in ? own.in.inStop : (b ? b.inStop : 0.5),
                    outStart: own.out ? own.out.outStart : (b ? b.outStart : Math.max(0, dur - 3)),
                    outStop: own.out ? own.out.outStop : (b ? b.outStop : dur),
                    __xfdj: true,
                };
                // Старый таймер движка в момент переключения сравнивает позицию нового трека
                // с inStop текущего — поднимаем inStop, чтобы он не оборвал переход.
                if (own.out && Number.isFinite(own.out.partnerInStart)) {
                    out.inStop = Math.max(out.inStop, Math.min(own.out.partnerInStart, out.outStart - 1.5));
                }
                return out;
            } catch (e) { return base; }
        };
        if (typeof origCan === 'function') {
            proto.canBeCrossedWith = function (other) {
                try {
                    const x = window.__xfdj;
                    if (x && x.active() && x.planFor(idOf(this), idOf(other))) return true;
                } catch (_) {}
                return origCan.apply(this, arguments);
            };
        }
        proto.__xfdjPatched = true;
        S.patchedProtos.add(proto);
        log('подключился к точкам перехода плеера');
    }

    function applyPlan(cur, next, p) {
        const curId = idOf(cur), nextId = idOf(next);
        // Сбрасываем «выход» у прошлого текущего трека, если он был
        for (const [id, v] of S.params) if (v.out && id !== curId) { delete v.out; if (!v.in) S.params.delete(id); }
        const curP = S.params.get(curId) || {};
        curP.out = { outStart: p.a.outStart, outStop: p.a.outStop, partnerInStart: p.b.inStart };
        S.params.set(curId, curP);
        const nextP = S.params.get(nextId) || {};
        nextP.in = { inStart: p.b.inStart, inStop: p.b.inStop };
        S.params.set(nextId, nextP);
        S.plan = Object.assign({ curId, nextId, curTitle: titleOf(cur), nextTitle: titleOf(next), createdAt: Date.now() }, p);
        S.entryAt.set(nextId, p.b.inStart + p.mixSec * (p.rate || 1));
        if (S.entryAt.size > 50) S.entryAt.delete(S.entryAt.keys().next().value);
        log(`план: ${p.kind === 'beatmatch' ? 'бит в бит' : p.kind === 'fade' ? 'плавный уход' : 'обычный переход'} — выход ${fmt(p.a.outStart)} → вход ${fmt(p.b.inStart)}, ${p.mixSec.toFixed(1)} с` +
            (p.rate !== 1 ? `, темп ${p.rate > 1 ? '+' : ''}${((p.rate - 1) * 100).toFixed(1)}%` : '') + ` (${p.reason})`);
        rearm();
    }

    function rearm() {
        const e = engine();
        const { cur, next } = pairs();
        if (!e || !cur || !next) return;
        if (val(e.isCrossing)) { S.rearmPending = true; return; }
        const el = currentAudio();
        const t = el ? el.currentTime : 0;
        const p = S.plan;
        if (p && p.curId === idOf(cur) && Number.isFinite(t) && t > p.a.outStart - 2) {
            log('план опоздал: точка выхода уже прошла');
            return;
        }
        try { e.startTimeTracking(cur, next); S.rearmPending = false; }
        catch (er) { err('startTimeTracking', er); return; }
        reprepare(e, next);
    }

    // Плеер заранее загружает следующий трек с позиции старта перехода. Если наш план
    // поменял точку входа, старая загрузка не подойдёт и в момент перехода трек начнёт
    // грузиться заново (тишина и опоздание). Поэтому переподготавливаем его.
    function reprepare(e, next) {
        try {
            const pl = e.pulseSyncCrossfadePlan;
            if (!pl || pl.nextPair !== next || typeof e.preparePlayback !== 'function' || typeof e.getCrossingStartPosition !== 'function') return;
            if (typeof e.isGaplessEnabled === 'function' && !e.isGaplessEnabled()) { log('предзагрузка выключена в плеере'); return; }
            const pos = e.getCrossingStartPosition(pl.currentParams, pl.nextParams);
            if (!Number.isFinite(pos)) return;
            const pp = e.preparedPlayback;
            if (pp && pp.pair && pp.pair.entity === next.entity && pp.positionSec === pos && !(pp.controller && pp.controller.signal.aborted)) return;
            const t0 = Date.now();
            Promise.resolve(e.preparePlayback(next, pos)).then(r => {
                log(r ? `следующий трек подготовлен с ${fmt(pos)} (${Date.now() - t0} мс)` : 'подготовка следующего трека не удалась');
            }, er => err('preparePlayback', er));
        } catch (er) { err('reprepare', er); }
    }

    // ---------- движок: журнал, страховка, подгонка темпа ----------
    function hookEngine(e) {
        if (!e || S.hookedEngines.has(e)) return;
        S.hookedEngines.add(e);
        log('движок кроссфейда найден');
        try {
            const lg = e.logger;
            if (lg && typeof lg.log === 'function' && !lg.__xfdjWrapped) {
                const orig = lg.log;
                lg.log = function (level, message) {
                    try {
                        if (typeof message === 'string') {
                            if (message.startsWith('Проигрывание с пересечением')) onCrossStart(e);
                            if (message.startsWith('Автопереключение')) log('движок: автопереключение');
                        }
                    } catch (_) {}
                    return orig.apply(this, arguments);
                };
                lg.__xfdjWrapped = true;
            }
        } catch (er) { err('hook logger', er); }
        try {
            if (!e.__xfdjStopGuard && typeof e.stopCrossing === 'function') {
                const origStop = e.stopCrossing;
                e.stopCrossing = function () {
                    try {
                        if (S.alive && S.settings.enabled && S.crossStartAt && Date.now() - S.crossStartAt < 3000 && !val(e.isCrossing)) {
                            log('заблокирован ранний обрыв перехода');
                            return;
                        }
                    } catch (_) {}
                    return origStop.apply(this, arguments);
                };
                e.__xfdjStopGuard = true;
            }
        } catch (er) { err('hook stopCrossing', er); }
        try {
            e.isCrossing && e.isCrossing.onChange && e.isCrossing.onChange(v => {
                if (!S.alive) return;
                if (v === true) S.crossingSince = Date.now();
                if (v === false) {
                    if (S.crossingSince) { log(`наложение длилось ${((Date.now() - S.crossingSince) / 1000).toFixed(1)} с`); S.crossingSince = 0; }
                    const fr = FX.running();
                    if (fr && Date.now() - fr.startedAt < 600 * fr.plan.mixSec) { FX.abort(); log('переход прерван — эффекты сняты'); }
                    if (S.rearmPending) setTimeout(rearm, 50);
                    if (S.sync) S.sync.crossEndedAt = Date.now();
                    setTimeout(releaseRampEl, 400);
                }
                renderSoon();
            });
        } catch (er) { err('hook isCrossing', er); }
    }

    function onCrossStart(e) {
        S.crossStartAt = Date.now();
        // Прошлая подгонка темпа (если ещё идёт) — сразу возвращаем нормальный темп
        if (S.sync) { try { const el = S.sync.getIn(); if (el) el.playbackRate = 1; } catch (_) {} stopSync(); }
        const p = S.plan;
        const getIn = () => { const mp = e.crossInMediaPlayer; return mp ? val(mp.currentAudioElement) : null; };
        const getOut = () => { const mp = e.crossOutMediaPlayer; return mp ? val(mp.currentAudioElement) : null; };
        const { cur } = pairs();
        log(`переход начался${p ? ` (${p.kind})` : ''}`);
        // План должен относиться именно к этому переходу
        if (!p || (cur && idOf(cur) !== p.nextId && idOf(cur) !== p.curId)) return;
        const rateFactor = p.kind === 'beatmatch' && S.settings.tempoSync ? p.rate : 1;
        startGuard(p, getIn, getOut, rateFactor);
        if (p.kind === 'beatmatch' && S.settings.tempoSync) startSync(p, getIn, getOut, e);
        startFx(p, getIn, getOut, 0);
    }

    function startFx(p, getIn, getOut, attempt) {
        if (!S.alive || S.settings.fx === 'off') return;
        const inEl = getIn(), outEl = getOut();
        if ((!inEl || !outEl || inEl === outEl) && attempt < 6) { setTimeout(() => startFx(p, getIn, getOut, attempt + 1), 150); return; }
        if (!inEl || !outEl) { log('эффекты: не нашёл элементы перехода'); return; }
        const rA = outEl.playbackRate || 1;
        const d0 = (p.a.outStart - outEl.currentTime) / rA;
        const pw = Object.assign({}, p, { mixSec: p.mixSec / rA, beatPeriodA: p.beatPeriodA ? p.beatPeriodA / rA : p.beatPeriodA });
        const r = FX.run(pw, { inEl, outEl, mode: S.settings.fx, params: S.settings.fxp, d0: Number.isFinite(d0) ? d0 : 0 });
        S.lastFx = Object.assign({ at: clock(), d0: Number.isFinite(d0) ? +d0.toFixed(2) : null }, r);
        log(r.ok ? `эффекты: ${r.name}` : `эффекты не включились: ${r.reason}`);
    }

    // Страж старта: первые 4 с следим, что входящий трек стоит там, где нужно.
    // Бывает, что плеер запускает его с начала вместо точки входа — тогда ставим на место.
    function startGuard(p, getIn, getOut, rateFactor) {
        const t0 = Date.now();
        let fixes = 0, reported = false;
        const timer = setInterval(() => {
            try {
                const elapsed = (Date.now() - t0) / 1000;
                if (!S.alive || elapsed > 4) { clearInterval(timer); return; }
                const inEl = getIn(), outEl = getOut();
                if (!inEl || !outEl || inEl.paused || outEl.paused || (inEl.readyState || 4) < 2) return;
                const expected = p.b.inStart + rateFactor * (outEl.currentTime - p.a.outStart);
                const errSec = inEl.currentTime - expected;
                if (elapsed > 0.3 && Math.abs(errSec) > 0.6 && fixes < 2 && expected > 0) {
                    log(`поправил старт следующего трека: был на ${inEl.currentTime.toFixed(2)} с, нужно ${expected.toFixed(2)} с`);
                    inEl.currentTime = expected + 0.05;
                    fixes++;
                    return;
                }
                if (!reported && elapsed > 1.5) {
                    reported = true;
                    log(`вход: следующий на ${inEl.currentTime.toFixed(2)} с, ожидалось ${expected.toFixed(2)} с (${Math.abs(errSec) > 0.15 ? 'расхождение ' + errSec.toFixed(2) + ' с' : 'вовремя'})`);
                }
            } catch (er) { err('страж старта', er); clearInterval(timer); }
        }, 100);
    }

    function startSync(p, getIn, getOut, e) {
        stopSync();
        const sync = { p, getIn, getOut, startedAt: Date.now(), errs: [], seeks: 0, phase: 'mix', timer: 0, el: null, outEl: null, integ: 0 };
        const rateA = p.rateA || 1;
        const wallMix = p.mixSec / rateA;
        sync.timer = setInterval(() => {
            try {
                if (!S.alive) return stopSync();
                const elapsed = (Date.now() - sync.startedAt) / 1000;
                if (sync.phase === 'mix') {
                    const inEl = getIn(), outEl = getOut();
                    if (inEl) { sync.el = inEl; try { inEl.preservesPitch = true; } catch (_) {} }
                    if (outEl) { sync.outEl = outEl; try { outEl.preservesPitch = true; } catch (_) {} }
                    const crossing = !!val(e.isCrossing);
                    const over = !inEl || !outEl || outEl.ended || elapsed > wallMix + 2 ||
                        (sync.crossEndedAt && Date.now() - sync.crossEndedAt > 300) ||
                        (elapsed > 1.5 && !crossing && (outEl.paused || inEl.paused));
                    if (over) {
                        sync.phase = 'release';
                        sync.releaseFrom = sync.el ? sync.el.playbackRate : 1;
                        sync.releaseAt = Date.now();
                        // Чем сильнее сдвинут темп, тем дольше и незаметнее возвращаем его
                        sync.releaseMs = Math.abs(sync.releaseFrom - 1) > 0.04 ? 16000 : 8000;
                        if (sync.outEl && sync.outEl !== sync.el) { try { sync.outEl.playbackRate = 1; } catch (_) {} }
                        return;
                    }
                    if (inEl.paused || outEl.paused) return;   // пауза пользователя посреди перехода
                    // Уходящий держим в темпе встречи
                    if (rateA !== 1 && Math.abs(outEl.playbackRate - rateA) > 0.0005) outEl.playbackRate = rateA;
                    const outRate = outEl.playbackRate || 1;
                    const tA = outEl.currentTime, tB = inEl.currentTime;
                    const target = p.b.inStart + p.rate * (tA - p.a.outStart);
                    const errWall = (tB - target) / (p.rate * outRate);   // в секундах на часах; >0 — B спешит
                    if (inEl.seeking || Date.now() < (sync.holdUntil || 0)) return;
                    // Первые 3 с входящий трек ещё тихий — ставим его точно в долю перемоткой;
                    // дальше только мягко подтягиваем темпом
                    const seekLimit = elapsed < 3 ? 0.04 : 0.25;
                    if (Math.abs(errWall) > seekLimit && elapsed < 3.5 && sync.seeks < 3) {
                        inEl.currentTime = target + p.rate * 0.02;
                        sync.seeks++;
                        sync.holdUntil = Date.now() + 350;
                        return;
                    }
                    if (elapsed > 0.6) sync.errs.push(Math.abs(errWall));
                    // ПИ-регулятор: пропорциональная часть ловит фазу, интегральная — остаточную разницу темпа
                    sync.integ = Math.max(-0.2, Math.min(0.2, sync.integ + errWall * 0.05));
                    const corr = Math.max(-0.06, Math.min(0.06, 2.5 * errWall + 0.8 * sync.integ));
                    const rate = outRate * p.rate * (1 - corr);
                    if (Math.abs(inEl.playbackRate - rate) > 0.0005) inEl.playbackRate = rate;
                } else {
                    // Плавно возвращаем исходный темп
                    const el = sync.el;
                    const k = Math.min(1, (Date.now() - sync.releaseAt) / (sync.releaseMs || 8000));
                    const rate = sync.releaseFrom + (1 - sync.releaseFrom) * (k * k * (3 - 2 * k));
                    if (el) el.playbackRate = rate;
                    if (k >= 1) { if (el) el.playbackRate = 1; finishSync(); }
                }
            } catch (er) { err('синхронизация', er); stopSync(); }
        }, 50);
        S.sync = sync;
        log(rateA !== 1 ? `подгонка темпа: встреча на ${p.meetBpm} BPM (старый ×${rateA.toFixed(3)}, новый ×${(p.rateB || p.rate).toFixed(3)})` : `подгонка темпа: ×${p.rate.toFixed(3)}`);
    }
    function finishSync() {
        const s = S.sync;
        if (!s) return;
        const errs = s.errs.slice().sort((a, b) => a - b);
        const median = errs.length ? errs[Math.floor(errs.length / 2)] : null;
        const p90 = errs.length ? errs[Math.floor(errs.length * 0.9)] : null;
        S.lastSync = { median, p90, seeks: s.seeks, title: s.p.nextTitle, samples: errs.length };
        if (median != null) log(`переход завершён: расхождение долей ~${Math.round(median * 1000)} мс (90%: ${Math.round(p90 * 1000)} мс, перемоток ${s.seeks})`);
        stopSync();
    }
    function stopSync() {
        const s = S.sync;
        if (!s) return;
        clearInterval(s.timer);
        S.sync = null;
        try { if (s.el && s.el.playbackRate !== 1) s.el.playbackRate = 1; } catch (_) {}
        try { if (s.outEl && s.outEl.playbackRate !== 1) s.outEl.playbackRate = 1; } catch (_) {}
    }

    // ---------- темп старого трека перед переходом ----------
    // За rampBars тактов до точки выхода уходящий трек плавно (S-кривая) идёт к темпу встречи.
    function rampTick() {
        if (!S.alive) return;
        try {
            const e = engine(), p = S.plan;
            if (!e || val(e.isCrossing) || S.sync && S.sync.phase === 'mix') return;
            const el = currentAudio();
            if (!el) return;
            const { cur } = pairs();
            const own = S.rampEl === el;
            let target = 1;
            if (p && S.settings.enabled && S.settings.tempoSync && p.kind === 'beatmatch' && cur && idOf(cur) === p.curId && p.rateA && p.rateA !== 1) {
                const len = (p.rampBars || 8) * 4 * (p.beatPeriodA || 0.5);
                const k = Math.max(0, Math.min(1, (el.currentTime - (p.a.outStart - len)) / len));
                target = 1 + (p.rateA - 1) * (k * k * (3 - 2 * k));
                if (k > 0 && !own) { S.rampEl = el; log(`темп старого трека плавно идёт к ${p.meetBpm} BPM`); }
            }
            if (S.rampEl !== el) return;                       // элемент не наш — не трогаем
            if (S.sync && S.sync.el === el) return;            // идёт возврат темпа после прошлого перехода
            // Не больше 2% в секунду — даже если план появился поздно
            const curRate = el.playbackRate || 1;
            const next = curRate + Math.max(-0.002, Math.min(0.002, target - curRate));
            try { el.preservesPitch = true; } catch (_) {}
            if (Math.abs(next - curRate) > 0.0002) el.playbackRate = next;
            if (target === 1 && Math.abs(next - 1) < 0.0005) { el.playbackRate = 1; S.rampEl = null; }
        } catch (er) { err('темп перед переходом', er); }
    }
    // После перехода старый элемент возвращаем к обычной скорости
    function releaseRampEl() {
        const el = S.rampEl;
        if (el && el !== currentAudio()) { try { el.playbackRate = 1; } catch (_) {} S.rampEl = null; }
    }

    // ---------- главный цикл ----------
    function setEngineEnabled(e, on) {
        try {
            if (on) {
                if (S.engineOrigEnabled === null) S.engineOrigEnabled = !!val(e.isEnabled);
                if (!val(e.isEnabled)) e.isEnabled.value = true;
            } else if (S.engineOrigEnabled !== null) {
                if (!val(e.isCrossing)) e.isEnabled.value = S.engineOrigEnabled;
                S.engineOrigEnabled = null;
            }
        } catch (er) { err('isEnabled', er); }
    }

    function tick() {
        if (!S.alive) return;
        try {
            const e = engine();
            if (!e) { S.status = 'жду плеер…'; renderSoon(); return; }
            hookEngine(e);
            scanFx(e);
            const { cur, next } = pairs();
            if (cur) patchPairProto(cur);
            if (next) patchPairProto(next);
            if (!S.settings.enabled) { setEngineEnabled(e, false); renderSoon(); return; }
            setEngineEnabled(e, true);
            if (!cur) { renderSoon(); return; }
            const A = ensureAnalysis(cur);
            const B = next ? ensureAnalysis(next) : null;
            if (!next) { S.status = 'нет следующего трека'; renderSoon(); return; }
            const curId = idOf(cur), nextId = idOf(next);
            const aDone = A || (S.analyses.get(curId));
            const bDone = B || (S.analyses.get(nextId));
            if (!aDone || !bDone) { renderSoon(); return; }
            const key = `${curId}>${nextId}|${aDone.ok ? 1 : 0}${bDone.ok ? 1 : 0}|${S.settings.mixBars}|${S.settings.style}|${S.settings.tempoSync}|${S.settings.maxStretch}|${pval('fadeSec')}|${pval('maxMixSec')}|${S.settings.toDrop}|${pval('minPlay')}|${(S.entryAt.get(curId) || 0).toFixed(1)}`;
            if (key !== S.planKey) {
                S.planKey = key;
                const yA = safeBase(cur), yB = safeBase(next);
                const p = XFPlanner.plan({
                    A: aDone, B: bDone,
                    durA: durOf(cur, aDone), durB: durOf(next, bDone),
                    settings: { mixBars: S.settings.mixBars, style: S.settings.style, tempoSync: S.settings.tempoSync, maxStretch: S.settings.maxStretch, fadeSec: pval('fadeSec'), maxMixSec: pval('maxMixSec'), toDrop: S.settings.toDrop !== false, minPlay: pval('minPlay') },
                    startA: S.entryAt.get(curId) || 0,
                    yandexA: yA, yandexB: yB,
                });
                applyPlan(cur, next, p);
            }
            S.status = 'готов';
        } catch (er) { err('tick', er); }
        renderSoon();
    }
    function scanFx(e) {
        const st = FX.stats();
        if (!st.installed || st.chains >= 2) return;
        if (S.fxScans && Date.now() - S.fxScanAt < 20000) return;
        S.fxScanAt = Date.now();
        S.fxScans = (S.fxScans || 0) + 1;
        try {
            const r = FX.discover([playback(), e, window.pulsesyncApi]);
            const now = FX.stats().chains;
            if (now !== S.fxLastCount) { log(`эффекты: подключено к ${now} аудиоэлементам (просмотрено ${r.scanned} объектов)`); S.fxLastCount = now; }
        } catch (er) { err('эффекты: поиск', er); }
    }
    // Точки Яндекса (без нашей подмены) — как подсказка планировщику
    function safeBase(pair) {
        try {
            const id = idOf(pair);
            const saved = S.params.get(id);
            S.params.delete(id);
            const r = pair.getCrossParams();
            if (saved) S.params.set(id, saved);
            return r && typeof r === 'object' ? r : null;
        } catch (_) { return null; }
    }

    // ---------- панель ----------
    let panel = null, renderTimer = 0;
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function renderSoon() {
        if (renderTimer || !S.alive) return;
        renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 250);
    }
    function buildPanel() {
        if (panel && panel.isConnected) return panel;
        if (!document.body) return null;
        document.getElementById('xfdj-panel')?.remove();
        panel = document.createElement('div');
        panel.id = 'xfdj-panel';
        panel.addEventListener('click', onPanelClick);
        // Пока тянем ползунок, панель не перерисовываем — иначе он «выскальзывает»
        panel.addEventListener('pointerdown', (ev) => { if (ev.target && ev.target.matches && ev.target.matches('input[type=range]')) S.dragging = Date.now(); });
        panel.addEventListener('input', (ev) => onSlider(ev, false));
        panel.addEventListener('change', (ev) => onSlider(ev, true));
        document.body.appendChild(panel);
        return panel;
    }
    function onPanelClick(ev) {
        const el = ev.target && ev.target.closest && ev.target.closest('[data-a]');
        if (!el) return;
        const a = el.getAttribute('data-a'), v = el.getAttribute('data-v');
        const s = S.settings;
        if (a === 'toggle') { s.enabled = !s.enabled; S.planKey = null; if (!s.enabled) { stopSync(); rearm(); } log(s.enabled ? 'включено' : 'выключено'); }
        if (a === 'panel') s.panel = s.panel === 'full' ? 'mini' : 'full';
        if (a === 'settings') S.showSettings = !S.showSettings;
        if (a === 'mixBars') { s.mixBars = v === 'auto' ? 'auto' : Number(v); S.planKey = null; }
        if (a === 'style') { s.style = v; S.planKey = null; }
        if (a === 'fx') { s.fx = v; if (v === 'off') FX.abort(); }
        if (a === 'toDrop') { s.toDrop = s.toDrop === false; S.planKey = null; }
        if (a === 'tempoSync') { s.tempoSync = !s.tempoSync; S.planKey = null; }
        if (a === 'maxStretch') { s.maxStretch = Number(v); s.tempoSync = true; S.planKey = null; }
        if (a === 'preset') applyPreset(v);
        if (a === 'listen') { listenTransition(); return; }
        if (a === 'copy') {
            const json = JSON.stringify(report(), null, 2);
            navigator.clipboard.writeText(json).then(() => { el.textContent = 'Скопировано ✓'; }, () => { console.log(TAG, json); el.textContent = 'См. консоль'; });
            setTimeout(() => { el.textContent = 'Отчёт'; }, 2500);
            return;
        }
        saveSettings();
        tick();
        render();
    }
    function trackLine(pair) {
        if (!pair) return '—';
        const id = idOf(pair);
        const a = S.analyses.get(id);
        let info;
        if (S.pending.has(id)) info = '<span class="xfdj-dim">анализ…</span>';
        else if (a && a.ok) info = `<b>${a.bpm}</b> BPM` + (a.confidence < 2.5 ? ' <span class="xfdj-warn">(ритм неясен)</span>' : '');
        else if (a) info = `<span class="xfdj-warn">${esc(a.reason || 'ошибка')}</span>`;
        else info = '<span class="xfdj-dim">ожидание</span>';
        return `${esc(titleOf(pair))} · ${info}`;
    }
    // ---------- ползунки ----------
    // Параметры планировщика (влияют на сам план) + параметры эффектов (XFEffects.PARAMS)
    const PLAN_PARAMS = {
        fadeSec:   { def: 4,   min: 3, max: 12, step: 0.5, label: 'Длина плавного ухода', unit: 'с' },
        maxMixSec: { def: 20,  min: 8, max: 40, step: 1,   label: 'Макс. длина «бит в бит»', unit: 'с' },
        minPlay:   { def: 80,  min: 20, max: 150, step: 5, label: 'Минимум звучания трека', unit: 'с' },
    };
    const PRESETS = {
        // Как на сете: длинное сведение 8 тактов, вход с начала фразы, обмен басов за долю,
        // голос старого поверх нового бита, эхо-выход в такт. Темп двигаем не больше 10% — иначе слышно.
        pro:   { label: '🎧 Профи', settings: { fx: 'pro', mixBars: 'auto', style: 'smooth', tempoSync: true, maxStretch: 0.10, toDrop: true },
                 fx: { lowKill: -30, swapAt: 0.5, swapBeats: 1, iso: 0.6, filter: 0.75, openIn: 0.6, voxLevel: 1.4, voxDip: -6, voxBack: 0.75, echo: 0.45, echoTail: 0.4, echoFrom: 0.8 },
                 plan: { fadeSec: 4, maxMixSec: 32 } },
        soft:  { label: 'Мягкий', fx: { swapBeats: 6, iso: 0.75, filter: 0.5, openIn: 0.4, echo: 0.4, echoTail: 0.35, voxLevel: 1.4, voxDip: -6, thin: 0.5, lowKill: -22 }, plan: { fadeSec: 7, maxMixSec: 30 } },
        std:   { label: 'Стандарт', fx: BASE_FX, settings: BASE_SETTINGS, plan: {} },
        club:  { label: 'Клубный', fx: { swapBeats: 0, iso: 0.3, filter: 0.9, openIn: 0.8, echo: 0.75, echoTail: 0.6, voxLevel: 1.6, voxDip: -10, thin: 1, lowKill: -32 }, plan: { fadeSec: 4, maxMixSec: 20 } },
    };
    const GROUPS = [
        { title: 'Длина', keys: ['fadeSec', 'maxMixSec', 'minPlay'], modes: ['auto', 'eq', 'vocal', 'pro', 'off'] },
        { title: 'Бит в бит', keys: ['lowKill', 'swapAt', 'swapBeats', 'thin'], modes: ['auto', 'eq'] },
        { title: 'Обмен басов', keys: ['lowKill', 'swapAt', 'swapBeats'], modes: ['pro'] },
        { title: 'Плавный уход', keys: ['filter', 'openIn'], modes: ['auto', 'eq'] },
        { title: 'Вокал поверх', keys: ['iso', 'voxLevel', 'voxDip', 'voxBack', 'lowKill'], modes: ['vocal'] },
        { title: 'Голос и фильтры', keys: ['iso', 'filter', 'openIn', 'voxLevel', 'voxDip', 'voxBack'], modes: ['pro'] },
        { title: 'Эхо', keys: ['echo', 'echoTail', 'echoFrom'], modes: ['auto', 'vocal', 'pro'] },
    ];
    const pdef = (k) => PLAN_PARAMS[k] || XFEffects.PARAMS[k];
    function pval(k) {
        const d = pdef(k), store = PLAN_PARAMS[k] ? S.settings : (S.settings.fxp || {});
        const v = Number(store[k]);
        return Number.isFinite(v) && store[k] != null ? Math.max(d.min, Math.min(d.max, v)) : d.def;
    }
    function fmtParam(k, v) {
        const u = pdef(k).unit;
        if (u === '%') return `${Math.round(v * 100)}%`;
        if (u === '×') return `×${v.toFixed(2)}`;
        if (u === 'дБ') return `${v} дБ`;
        if (u === 'с') return `${v} с`;
        return `${v} ${u}`;
    }
    function sliderGroups(s) {
        return GROUPS.filter(g => g.modes.includes(s.fx)).map(g => `<div class="xfdj-group"><div class="xfdj-gt">${g.title}</div>` +
            g.keys.filter(k => !(k === 'thin' && s.fx === 'eq')).map(k => {
                const d = pdef(k), v = pval(k);
                return `<label class="xfdj-slider"><span>${d.label}</span><b data-pv="${k}">${fmtParam(k, v)}</b>` +
                    `<input type="range" data-p="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"></label>`;
            }).join('') + `</div>`).join('');
    }
    function onSlider(ev, commit) {
        const t = ev.target;
        if (!t || !t.getAttribute || !t.hasAttribute('data-p')) return;
        const k = t.getAttribute('data-p'), v = Number(t.value);
        if (PLAN_PARAMS[k]) S.settings[k] = v;
        else { S.settings.fxp = S.settings.fxp || {}; S.settings.fxp[k] = v; }
        S.settings.preset = null;
        for (const b of panel.querySelectorAll(`[data-pv="${k}"]`)) b.textContent = fmtParam(k, v);
        // Такой же ползунок в другой группе (срез басов) — синхронизируем
        for (const o of panel.querySelectorAll(`input[data-p="${k}"]`)) if (o !== t) o.value = v;
        if (commit) {
            S.dragging = false;
            if (PLAN_PARAMS[k]) S.planKey = null;
            saveSettings();
            tick();
        }
    }
    function applyPreset(name) {
        const s = S.settings;
        if (name === 'reset') name = 'std';
        {
            const pr = PRESETS[name]; if (!pr) return;
            s.fxp = Object.assign({}, pr.fx);
            if (pr.settings) Object.assign(s, pr.settings);
            for (const k in PLAN_PARAMS) { if (pr.plan[k] != null) s[k] = pr.plan[k]; else delete s[k]; }
            s.preset = name;
        }
        S.planKey = null;
        log(`пресет: ${PRESETS[name].label}`);
    }
    // Перемотать текущий трек к переходу, чтобы сразу его услышать
    function listenTransition() {
        const { cur } = pairs();
        const p = S.plan && cur && S.plan.curId === idOf(cur) ? S.plan : null;
        if (!p) { log('нет плана перехода — нечего слушать'); return; }
        const t = Math.max(0, p.a.outStart - 6);
        const pb = playback();
        const done = () => { log(`перемотал к переходу (${fmt(t)})`); setTimeout(rearm, 400); };
        try {
            if (pb && typeof pb.setProgress === 'function') Promise.resolve(pb.setProgress(t)).then(done, er => { err('перемотка', er); const el = currentAudio(); if (el) { el.currentTime = t; done(); } });
            else { const el = currentAudio(); if (el) { el.currentTime = t; done(); } }
        } catch (er) { err('перемотка', er); }
    }

    function render() {
        if (!S.alive) return;
        if (S.dragging && Date.now() - S.dragging < 4000) { renderSoon(); return; }
        try {
            const root = buildPanel();
            if (!root) return;
            const s = S.settings;
            const e = engine();
            const { cur, next } = pairs();
            const el = currentAudio();
            const p = S.plan && cur && S.plan.curId === idOf(cur) ? S.plan : null;
            const kindName = p ? (p.kind === 'beatmatch' ? 'бит в бит' : p.kind === 'fade' ? 'плавный уход' : 'обычный') : '';
            const left = p && el ? p.a.outStart - el.currentTime : NaN;
            root.className = s.panel === 'mini' ? 'xfdj-mini' : '';
            const head = `<div class="xfdj-head">
                <span class="xfdj-title">Crossfade DJ</span>
                <button class="xfdj-switch ${s.enabled ? 'on' : ''}" data-a="toggle" title="Включить/выключить">${s.enabled ? 'ВКЛ' : 'ВЫКЛ'}</button>
                <button data-a="settings" title="Настройки">⚙</button>
                <button data-a="panel" title="Свернуть">${s.panel === 'mini' ? '▢' : '_'}</button></div>`;
            if (s.panel === 'mini') {
                root.innerHTML = head + `<div class="xfdj-row">${p ? `${kindName}${Number.isFinite(left) && left > 0 ? ' · через ' + fmt(left) : ''}` : esc(S.status)}</div>`;
                return;
            }
            let html = head;
            if (!e) html += `<div class="xfdj-row xfdj-warn">${esc(S.status)}</div>`;
            else {
                html += `<div class="xfdj-row"><span class="xfdj-k">сейчас</span> ${trackLine(cur)}</div>`;
                html += `<div class="xfdj-row"><span class="xfdj-k">далее</span> ${trackLine(next)}</div>`;
                if (!s.enabled) html += `<div class="xfdj-row xfdj-dim">выключено — переходы как у Яндекса</div>`;
                else if (p) {
                    html += `<div class="xfdj-plan"><b>${kindName}</b> · ${p.mixBars ? p.mixBars + ' тактов, ' : ''}${p.mixSec.toFixed(1)} с` +
                        (p.rateA && p.rateA !== 1 ? ` · встреча ${p.meetBpm} BPM (${((x) => (x > 1 ? '+' : '') + ((x - 1) * 100).toFixed(1) + '%')(p.rateA)} / ${((x) => (x > 1 ? '+' : '') + ((x - 1) * 100).toFixed(1) + '%')(p.rateB)})` : p.rate !== 1 ? ` · темп ${p.rate > 1 ? '+' : ''}${((p.rate - 1) * 100).toFixed(1)}%` : '') +
                        (s.fx !== 'off' && FX.stats().chains >= 2 ? ` · ${esc(XFEffects.program(p, { mode: s.fx, params: s.fxp }).name)}` : '') +
                        `<br>выход ${fmt(p.a.outStart)}` + (p.exitAligned ? ` (конец дропа ${fmt(p.a.outStop)})` : '') + ` → вход ${fmt(p.b.inStart)}` + (p.dropAligned ? ` → <b>дроп ${fmt(p.dropT)}</b>` : '') +
                        (Number.isFinite(left) ? (left > 0 ? ` · через <b>${fmt(left)}</b>` : val(e.isCrossing) ? ' · <b>идёт переход</b>' : '') : '') +
                        (p.kind !== 'beatmatch' ? `<br><span class="xfdj-dim">${esc(p.reason)}</span>` : '') + `</div>`;
                } else html += `<div class="xfdj-row xfdj-dim">${esc(S.status)}</div>`;
                if (S.lastSync && S.lastSync.median != null) html += `<div class="xfdj-row xfdj-dim">прошлый переход: доли ±${Math.round(S.lastSync.median * 1000)} мс</div>`;
            }
            if (S.showSettings) {
                const opt = (a, v, label, cur) => `<button data-a="${a}" data-v="${v}" class="${String(cur) === String(v) ? 'sel' : ''}">${label}</button>`;
                html += `<div class="xfdj-settings">
                    <div>Длина: ${opt('mixBars', 'auto', 'авто', s.mixBars)}${opt('mixBars', 4, '4 такта', s.mixBars)}${opt('mixBars', 8, '8', s.mixBars)}${opt('mixBars', 16, '16', s.mixBars)}</div>
                    <div>Вход: ${opt('style', 'smooth', 'плавный', s.style)}${opt('style', 'energy', 'на подъёме', s.style)}</div>
                    <div title="Сведение заканчивается ровно на дропе или припеве нового трека — дроп звучит уже чисто">До дропа: <button data-a="toDrop" class="${s.toDrop !== false ? 'sel' : ''}">${s.toDrop !== false ? 'вкл' : 'выкл'}</button></div>
                    <div title="Насколько можно изменить темп каждого трека. Темпы встречаются посередине, так что общая разница может быть вдвое больше.">Темп на трек: ${opt('maxStretch', 0.06, 'до 6%', s.tempoSync ? s.maxStretch : '')}${opt('maxStretch', 0.1, '10%', s.tempoSync ? s.maxStretch : '')}${opt('maxStretch', 0.15, '15%', s.tempoSync ? s.maxStretch : '')}${opt('maxStretch', 0.2, '20%', s.tempoSync ? s.maxStretch : '')}<button data-a="tempoSync" class="${s.tempoSync ? '' : 'sel'}">нет</button></div>
                    <div>Эффекты: ${opt('fx', 'auto', 'авто', s.fx)}${opt('fx', 'pro', 'профи', s.fx)}${opt('fx', 'eq', 'только EQ', s.fx)}${opt('fx', 'vocal', 'вокал поверх', s.fx)}${opt('fx', 'off', 'нет', s.fx)}</div>
                    <div>Пресет: ${Object.keys(PRESETS).map(k => `<button data-a="preset" data-v="${k}" class="${S.settings.preset === k ? 'sel' : ''}">${PRESETS[k].label}</button>`).join('')}<button data-a="preset" data-v="reset">Сбросить</button></div>
                    ${sliderGroups(s)}
                    <div><button data-a="listen" title="Перемотать текущий трек за 6 с до точки выхода">▶ Послушать переход</button> <button data-a="copy">Отчёт</button></div></div>`;
            }
            if (S.errors.length) html += `<div class="xfdj-row xfdj-warn" title="${esc(S.errors.slice(-3).join('\n'))}">ошибок: ${S.errors.length} (последняя: ${esc(S.errors[S.errors.length - 1].slice(0, 90))})</div>`;
            const scroll = root.scrollTop;
            root.innerHTML = html;
            root.scrollTop = scroll;
        } catch (e) { err('render', e); }
    }

    function report() {
        const { cur, next } = pairs();
        const e = engine();
        const strip = (a) => a ? Object.assign({}, a, { bars: a.bars ? `${a.bars.length} тактов` : undefined }) : a;
        return {
            version: VERSION, uptime: clock(), settings: S.settings, status: S.status,
            engine: e ? { isEnabled: val(e.isEnabled), isCrossing: val(e.isCrossing), forceDisabled: e.isCrossfadeForceDisabled, config: e.config } : null,
            current: cur ? { id: idOf(cur), title: titleOf(cur), analysis: strip(S.analyses.get(idOf(cur))), params: (() => { try { return cur.getCrossParams(); } catch (er) { return er.message; } })() } : null,
            next: next ? { id: idOf(next), title: titleOf(next), analysis: strip(S.analyses.get(idOf(next))), params: (() => { try { return next.getCrossParams(); } catch (er) { return er.message; } })() } : null,
            plan: S.plan, lastSync: S.lastSync, fx: Object.assign(FX.stats(), { last: S.lastFx }),
            audio: (() => { const el = currentAudio(); return el ? { t: el.currentTime, rate: el.playbackRate, paused: el.paused } : null; })(),
            log: S.log.slice(-80), errors: S.errors,
        };
    }

    // ---------- запуск / остановка ----------
    const timer = setInterval(tick, 1000);
    const rampTimer = setInterval(rampTick, 100);
    function dispose() {
        S.alive = false;
        clearInterval(timer);
        clearInterval(rampTimer);
        try { if (S.rampEl) S.rampEl.playbackRate = 1; } catch (_) {}
        stopSync();
        try { FX.uninstall(); } catch (_) {}
        try { const e = engine(); if (e) setEngineEnabled(e, false); } catch (_) {}
        try { panel && panel.remove(); } catch (_) {}
        S.params.clear();
        S.plan = null;
    }
    window.__xfdj = {
        version: VERSION,
        active: () => S.alive && S.settings.enabled,
        paramsFor: (id) => S.params.get(id) || null,
        planFor: (a, b) => S.plan && S.plan.curId === a && S.plan.nextId === b ? S.plan : null,
        state: S, report, dispose, tick,
    };
    log(`загружен v${VERSION}`);
    tick();
})();
