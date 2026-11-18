/*
 * Эффекты перехода на Web Audio.
 *
 * У плеера Яндекса на каждом <audio> свой граф: source → (эквалайзер) → анализатор →
 * громкость R128 → громкость кроссфейда → destination. Мы вставляем свою цепочку
 * в самый конец, перед destination:
 *
 *   вход → низы → ФВЧ → ФНЧ → «голосовая» полоса → центр/ширина (M/S) → уровень → сухой ──┐
 *                                                               └→ задержка ⟲ обратная связь → эхо ─┴→ выход → destination
 *
 * В обычное время цепочка нейтральна (0 дБ, фильтры открыты, эха нет).
 * На время перехода по плану расписываются автоматизации параметров.
 */
/* exported XFEffects */
var XFEffects = (function () {
    'use strict';

    const LOW_KILL = -26;   // дБ: «срезанные» низы
    const NEUTRAL = { low: 0, hp: 10, lp: 20000, wet: 0, fb: 0, vox: 0, width: 1, widthNeg: -1, level: 1 };

    // Настраиваемые параметры (ползунки в панели). Доли — от длины перехода.
    const PARAMS = {
        lowKill:   { def: -26,  min: -36, max: 0,    step: 1,    label: 'Срез басов', unit: 'дБ' },
        swapAt:    { def: 0.5,  min: 0.25, max: 0.75, step: 0.05, label: 'Обмен басов на', unit: '%' },
        swapBeats: { def: 2,    min: 0,   max: 8,    step: 1,    label: 'Плавность обмена басов', unit: 'долей' },
        thin:      { def: 0.75, min: 0,   max: 1,    step: 0.05, label: 'Истончение уходящего', unit: '%' },
        filter:    { def: 0.7,  min: 0,   max: 1,    step: 0.05, label: 'Сила фильтра', unit: '%' },
        openIn:    { def: 0.6,  min: 0,   max: 1,    step: 0.05, label: 'Раскрытие входящего', unit: '%' },
        echo:      { def: 0.6,  min: 0,   max: 1,    step: 0.05, label: 'Эхо: громкость', unit: '%' },
        echoTail:  { def: 0.45, min: 0,   max: 0.75, step: 0.05, label: 'Эхо: длина хвоста', unit: '%' },
        echoFrom:  { def: 0.5,  min: 0.1, max: 0.9,  step: 0.05, label: 'Эхо: начинается на', unit: '%' },
        iso:       { def: 0.5,  min: 0.1, max: 0.9,  step: 0.05, label: 'Плавность ухода инструментов', unit: '%' },
        voxLevel:  { def: 1.5,  min: 1,   max: 2,    step: 0.05, label: 'Громкость старого голоса', unit: '×' },
        voxDip:    { def: -8,   min: -15, max: 0,    step: 1,    label: 'Приглушение голоса нового', unit: 'дБ' },
        voxBack:   { def: 0.7,  min: 0.4, max: 0.95, step: 0.05, label: 'Голос нового возвращается на', unit: '%' },
    };
    const defaults = () => { const o = {}; for (const k in PARAMS) o[k] = PARAMS[k].def; return o; };
    function params(user) {
        const o = defaults();
        if (user) for (const k in PARAMS) if (user[k] != null && Number.isFinite(Number(user[k]))) o[k] = Math.max(PARAMS[k].min, Math.min(PARAMS[k].max, Number(user[k])));
        return o;
    }

    // S-кривая: плавный старт и плавное окончание (вместо резкой линейной рампы)
    const smooth = (k) => k * k * (3 - 2 * k);
    function expand(list) {
        const last = Object.assign({}, NEUTRAL), out = [];
        for (const s of list) {
            const from = s.from !== undefined ? s.from : last[s.p];
            if (s.curve && s.dur >= 0.15 && Number.isFinite(from)) {
                const N = 12;
                let prev = from;
                for (let i = 1; i <= N; i++) {
                    const k = smooth(i / N);
                    const v = s.exp && from > 0 && s.to > 0 ? from * Math.pow(s.to / from, k) : from + (s.to - from) * k;
                    out.push({ p: s.p, to: v, at: s.at + s.dur * (i - 1) / N, dur: s.dur / N, exp: false, from: prev });
                    prev = v;
                }
            } else out.push(Object.assign({}, s, { from }));
            last[s.p] = s.to;
        }
        return out;
    }

    // ---------- программа эффектов (чистая функция, тестируется отдельно) ----------
    // Время шагов — в секундах от момента старта перехода (на часах).
    // d0 — через сколько секунд уходящий трек дойдёт до точки выхода (может быть < 0).
    function program(plan, opts) {
        const mode = (opts && opts.mode) || 'auto';
        const d0 = (opts && Number.isFinite(opts.d0)) ? opts.d0 : 0;
        const P = params(opts && opts.params);
        const out = [], inn = [];
        const res = { out, in: inn, end: 0, echoTail: 0, delay: null, name: '' };
        if (!plan || mode === 'off') return res;
        const M = plan.mixSec;
        const beat = plan.beatPeriodA || 0;
        const step = (list, p, to, at, dur, exp, from, curve) => list.push({ p, to, at, dur: dur || 0, exp: !!exp, from, curve: curve !== false });
        const echoDelay = () => { let dl = beat || 0.5; while (dl < 0.25) dl *= 2; while (dl > 0.8) dl /= 2; return dl; };
        const finish = (r) => { r.out = expand(r.out); r.in = expand(r.in); return r; };
        const addEcho = (fromFrac) => {
            if (!beat || P.echo <= 0) return;
            res.delay = echoDelay();
            const t = d0 + fromFrac * M;
            step(out, 'fb', P.echoTail, t, 0, false, 0, false);
            step(out, 'wet', P.echo, t, Math.max(0.3, d0 + M - t), false, 0);
            res.echoTail = 2 + 6 * P.echoTail;
        };

        if (plan.dropAligned && plan.kind !== 'smooth') {
            // «До дропа»: сведение заканчивается ровно на дропе/припеве нового трека.
            // Новый трек весь подъём играет без баса (и с приглушённым голосом), за такт до дропа
            // у старого уходит бас («яма» перед дропом), эхо обрывается к дропу — и дроп звучит
            // уже только от нового трека, с полным басом.
            const tEnd = d0 + M;
            const bm = plan.kind === 'beatmatch';
            const bar = beat ? 4 * beat : Math.min(2, M / 4);
            const fx = mode !== 'eq';
            const vocal = mode === 'vocal', pro = mode === 'pro';
            const exitEnd = !!plan.exitAligned;   // старый трек уходит с конца своего дропа
            // входящий
            step(inn, 'low', P.lowKill, 0, 0, false, 0, false);
            step(inn, 'low', 0, tEnd - 0.04, 0.04, false, undefined, false);
            if (fx && !vocal && P.openIn > 0) {
                step(inn, 'lp', 20000, Math.max(0, d0), Math.max(0.5, tEnd - bar - Math.max(0, d0)), true, 20000 * Math.pow(300 / 20000, 0.7 * P.openIn));
            }
            if (vocal || pro) {
                step(inn, 'vox', P.voxDip, 0, 0, false, 0, false);
                step(inn, 'vox', 0, tEnd - 0.12, 0.12, false, undefined, false);
            }
            if (pro) step(inn, 'level', 1, Math.max(0, d0), Math.max(0.5, tEnd - bar - Math.max(0, d0)), false, 1.6);
            // уходящий
            if (vocal) {
                const iso = Math.max(0.8, P.iso * M);
                step(out, 'low', P.lowKill, d0, iso, false, 0);
                step(out, 'hp', 250, d0, iso, true, 10);
                step(out, 'lp', 6000, d0, iso * 1.15, true, 20000);
                step(out, 'width', 0, d0, iso * 1.3, false, 1);
            } else if (exitEnd) {
                // Старый трек на своём дропе: он должен звучать полно до самого конца.
                // Лишь слегка поджимаем низ на последних тактах, бас уходит на последней доле.
                if (bm && fx) step(out, 'hp', 40, d0 + 0.6 * M, Math.max(0.5, 0.4 * M - bar), true, 10);
                step(out, 'low', P.lowKill, tEnd - (beat || 0.3), 0.08, false, 0, false);
            } else {
                if (bm) {
                    const hpEnd = pro ? 60 + 300 * P.filter : 10 * Math.pow(60, P.thin);
                    if (fx && hpEnd > 11) step(out, 'hp', hpEnd, d0 + M / 2, Math.max(0.5, M / 2 - bar), true, 10);
                    if (pro) step(out, 'width', 0.6, d0 + M / 2, Math.max(0.5, M / 2 - bar), false, 1);
                } else if (P.filter > 0) {
                    step(out, 'hp', 150 * Math.pow(2500 / 150, P.filter) * (fx ? 1 : 0.4), d0, M, true, 20);
                }
                step(out, 'low', P.lowKill, tEnd - bar, Math.min(bar / 2, 1), false, 0);
            }
            if (exitEnd && !vocal) {
                // Движок убавляет старый трек на всём сведении — возвращаем громкость,
                // чтобы его дроп доиграл почти в полную силу и сменился дропом нового
                const lv = Math.max(1.5, P.voxLevel);
                step(out, 'level', lv, d0, Math.max(0.5, M - (beat || 0.3)), false, 1);
                step(out, 'level', 1, tEnd - (beat || 0.3) * 0.5, (beat || 0.3) * 0.5, false, undefined, false);
            } else if (vocal || pro) {
                step(out, 'level', P.voxLevel, d0, 0.5 * M, false, 1);
                step(out, 'level', 1, d0 + 0.8 * M, 0.2 * M);
            }
            // эхо — но к дропу его уже нет
            if (fx && beat && P.echo > 0) {
                const t0 = d0 + Math.max(0.4, Math.min(0.8, P.echoFrom)) * M, tStop = tEnd - beat;
                if (tStop - t0 > 0.3) {
                    res.delay = echoDelay();
                    step(out, 'fb', P.echoTail, t0, 0, false, 0, false);
                    step(out, 'wet', P.echo, t0, tStop - t0, false, 0);
                    step(out, 'wet', 0, tStop, beat, false, undefined, false);
                    step(out, 'fb', 0, tEnd, 0, false, undefined, false);
                }
            }
            res.end = tEnd + 0.4;
            res.dropAt = tEnd;
            res.name = `до дропа: ${vocal ? 'вокал поверх' : bm ? 'бит в бит' : 'фильтр'}`;
            return finish(res);
        }
        if (mode === 'vocal') {
            // «Вокал поверх»: у уходящего трека постепенно убираем бочку, бас, тарелки и стерео-края —
            // остаётся в основном голос; у входящего приглушена «голосовая» полоса.
            // Потом старый голос уходит в эхо, и новый трек открывается полностью.
            const bm = plan.kind === 'beatmatch';
            const bar = beat ? 4 * beat : M / 8;
            const iso = Math.max(0.8, P.iso * M);
            step(out, 'low', P.lowKill, d0, iso, false, 0);
            step(out, 'hp', 250, d0, iso, true, 10);
            step(out, 'lp', 6000, d0, iso * 1.15, true, 20000);
            step(out, 'width', 0, d0, iso * 1.3, false, 1);
            // Громкость уходящего движок убавляет сам — частично возвращаем, чтобы голос был слышен
            const back = Math.max(0.55, P.voxBack);
            step(out, 'level', P.voxLevel, d0, 0.5 * M, false, 1);
            step(out, 'level', 1, d0 + back * M, (1 - back) * M);
            addEcho(P.echoFrom);
            step(inn, 'vox', P.voxDip, 0, 0, false, 0, false);
            step(inn, 'vox', 0, d0 + P.voxBack * M, Math.max(0.5, Math.min(bm ? bar : 1.5, (1 - P.voxBack) * M)));
            res.end = d0 + M + 0.4;
            res.name = 'вокал поверх';
            return finish(res);
        }
        if (mode === 'pro') {
            // «Профи» — как сводят диджеи на пульте:
            //  1) новый трек заходит заранее, но без баса и с прикрытым верхом — только ритм и атмосфера;
            //  2) верх у нового постепенно открывается, «голосовая» полоса пока приглушена;
            //  3) на начале такта — быстрый обмен басов;
            //  4) после обмена старый трек истончается (без низа, уже по стерео), его голос
            //     остаётся поверх нового бита, громкость старого поддерживаем;
            //  5) голос нового возвращается, старый уходит в эхо в такт.
            if (plan.kind === 'beatmatch') {
                const bar = beat ? 4 * beat : M / 8;
                const bars = plan.mixBars >= 2 ? plan.mixBars : Math.max(2, Math.round(M / bar));
                const swapBar = Math.max(1, Math.min(bars - 1, Math.round(P.swapAt * bars)));
                const ts = d0 + swapBar * bar;
                const sw = Math.max(0.06, P.swapBeats * (beat || 0.5));
                const tEnd = d0 + M;
                // входящий
                step(inn, 'low', P.lowKill, 0, 0, false, 0, false);
                step(inn, 'low', 0, ts - sw / 2, sw);
                const lpStart = 20000 * Math.pow(300 / 20000, 0.7 * P.openIn);
                if (P.openIn > 0) step(inn, 'lp', 20000, d0, Math.max(0.5, ts - d0), true, lpStart);
                step(inn, 'vox', P.voxDip, 0, 0, false, 0, false);
                step(inn, 'vox', 0, d0 + P.voxBack * M, Math.max(0.5, Math.min(bar, (1 - P.voxBack) * M)));
                // Новый трек «выведен» раньше, чем по линейному фейдеру движка
                step(inn, 'level', 1, Math.max(0, d0), Math.max(0.5, ts - d0), false, 1.6);
                // уходящий: после обмена — истончается, голос остаётся поверх
                step(out, 'low', P.lowKill, ts - sw / 2, sw, false, 0);
                const thinDur = Math.max(1, P.iso * (tEnd - ts));
                step(out, 'hp', 60 + 300 * P.filter, ts, thinDur, true, 10);
                step(out, 'lp', 9000, ts, thinDur, true, 20000);
                step(out, 'width', 0.6, ts, thinDur, false, 1);
                step(out, 'level', P.voxLevel, ts - bar, bar, false, 1);
                const back = Math.max(P.voxBack, (ts - d0) / M + 0.05);
                step(out, 'level', 1, d0 + back * M, Math.max(0.5, (1 - back) * M));
                addEcho(Math.max(P.echoFrom, (ts - d0) / M + 0.1));
                res.end = tEnd + 0.5;
                res.swapAt = ts;
                res.name = 'профи: бит в бит';
                return finish(res);
            }
            // Темпы разные — диджей не сводит, а делает эхо-выход и «вброс» нового на начале такта
            const hpEnd = 150 * Math.pow(2500 / 150, P.filter);
            step(out, 'hp', hpEnd, d0, M, true, 20);
            step(out, 'width', 0.5, d0, M, false, 1);
            if (beat && P.echo > 0) {
                res.delay = echoDelay();
                step(out, 'fb', Math.min(0.75, P.echoTail + 0.1), d0 + 0.3 * M, 0, false, 0, false);
                step(out, 'wet', Math.min(1, P.echo * 1.3), d0 + 0.3 * M, 0.7 * M, false, 0);
                res.echoTail = 2 + 6 * P.echoTail;
            }
            if (P.openIn > 0) step(inn, 'lp', 20000, d0, 0.7 * M, true, 20000 * Math.pow(400 / 20000, P.openIn));
            step(inn, 'low', P.lowKill, 0, 0, false, 0, false);
            step(inn, 'low', 0, d0 + 0.7 * M, 0.3 * M);
            res.end = d0 + M + 0.3;
            res.name = beat && P.echo > 0 ? 'профи: эхо-выход' : 'профи: фильтр';
            return finish(res);
        }
        if (plan.kind === 'beatmatch') {
            // Обмен басов на начале такта ближе к выбранной точке
            const bar = beat ? 4 * beat : M / 8;
            const bars = plan.mixBars >= 2 ? plan.mixBars : Math.max(2, Math.round(M / bar));
            const swapBar = Math.max(1, Math.min(bars - 1, Math.round(P.swapAt * bars)));
            const ts = d0 + swapBar * bar;
            const sw = Math.max(0.06, P.swapBeats * (beat || 0.5));
            step(inn, 'low', P.lowKill, 0, 0, false, 0, false);
            step(inn, 'low', 0, ts - sw / 2, sw);
            step(out, 'low', P.lowKill, ts - sw / 2, sw, false, 0);
            if (mode === 'auto' && P.thin > 0) {
                const hpEnd = 10 * Math.pow(60, P.thin);
                step(out, 'hp', hpEnd, ts - sw / 2, Math.max(0.5, d0 + M - ts + sw / 2), true, 10);
            }
            res.end = d0 + M + 0.5;
            res.swapAt = ts;
            res.name = 'обмен басов';
        } else if (plan.kind === 'fade') {
            // Темпы разные: уходящий трек «улетает» фильтром (+ эхо в такт), входящий открывается
            const hpEnd = 150 * Math.pow(2500 / 150, P.filter) * (mode === 'auto' ? 1 : 0.4);
            if (P.filter > 0) step(out, 'hp', hpEnd, d0, M, true, 20);
            step(inn, 'low', 0, 0, d0 + M, false, Math.max(-14, P.lowKill));
            if (mode === 'auto') {
                if (P.openIn > 0) step(inn, 'lp', 20000, d0, 0.8 * M, true, 20000 * Math.pow(300 / 20000, P.openIn));
                addEcho(P.echoFrom * 0.8);
                res.name = P.echo > 0 ? 'фильтр и эхо' : 'фильтр';
            } else res.name = 'фильтр';
            res.end = d0 + M + 0.3;
        } else {
            // Ритм неизвестен: мягкий фильтр на уходящем и плавный ввод низов у входящего
            step(out, 'hp', 60 + 400 * P.filter, d0, M, true, 20);
            step(inn, 'low', 0, 0, d0 + M, false, Math.max(-12, P.lowKill));
            res.end = d0 + M + 0.3;
            res.name = 'мягкий фильтр';
        }
        return finish(res);
    }

    // ---------- граф ----------
    function create(hooks) {
        const log = (hooks && hooks.log) || (() => {});
        const err = (hooks && hooks.err) || (() => {});
        const hasWA = typeof AudioContext !== 'undefined' && typeof AudioNode !== 'undefined';
        const ctxEl = new WeakMap();      // AudioContext → <audio> (из createMediaElementSource)
        const chains = new Map();         // <audio> → цепочка
        const graphsSeen = new WeakSet();
        const timers = new Set();
        let origCreate = null, origConnect = null, installed = false;
        let destCtor = null;

        function isDest(n) { return destCtor && n instanceof destCtor; }

        function buildChain(ctx, el) {
            const c = origConnect;
            const g = () => ctx.createGain();
            const bq = (type, f) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; return n; };
            const lpMax = Math.min(20000, ctx.sampleRate / 2 - 200);
            const gv = (v) => { const n = g(); n.gain.value = v; return n; };
            const ch = {
                ctx, el, tails: new Set(),
                input: g(), low: bq('lowshelf', 180), hp: bq('highpass', NEUTRAL.hp), lp: bq('lowpass', lpMax),
                vox: bq('peaking', 1800),
                split: ctx.createChannelSplitter(2), mid: g(), sideL: gv(0.5), sideR: gv(-0.5), side: g(),
                wPos: gv(1), wNeg: gv(-1), midL: gv(0.5), midR: gv(0.5), merge: ctx.createChannelMerger(2), level: g(),
                dry: g(), delay: ctx.createDelay(2), fb: g(), wet: g(), output: g(), lpMax,
            };
            ch.hp.Q.value = 0.707; ch.lp.Q.value = 0.707; ch.vox.Q.value = 0.8; ch.vox.gain.value = 0;
            ch.low.gain.value = 0; ch.fb.gain.value = 0; ch.wet.gain.value = 0; ch.delay.delayTime.value = 0.5;
            // Моно-треки раскладываем на два одинаковых канала, иначе центр станет тише
            try { ch.split.channelInterpretation = 'speakers'; } catch (_) {}
            c.call(ch.input, ch.low); c.call(ch.low, ch.hp); c.call(ch.hp, ch.lp); c.call(ch.lp, ch.vox);
            // M/S: mid = (L+R)/2, side = (L-R)/2;  L' = mid + w*side, R' = mid - w*side
            c.call(ch.vox, ch.split);
            c.call(ch.split, ch.midL, 0); c.call(ch.split, ch.midR, 1); c.call(ch.midL, ch.mid); c.call(ch.midR, ch.mid);
            c.call(ch.split, ch.sideL, 0); c.call(ch.split, ch.sideR, 1); c.call(ch.sideL, ch.side); c.call(ch.sideR, ch.side);
            c.call(ch.side, ch.wPos); c.call(ch.side, ch.wNeg);
            c.call(ch.mid, ch.merge, 0, 0); c.call(ch.mid, ch.merge, 0, 1);
            c.call(ch.wPos, ch.merge, 0, 0); c.call(ch.wNeg, ch.merge, 0, 1);
            c.call(ch.merge, ch.level);
            c.call(ch.level, ch.dry); c.call(ch.dry, ch.output);
            c.call(ch.level, ch.delay); c.call(ch.delay, ch.fb); c.call(ch.fb, ch.delay);
            c.call(ch.delay, ch.wet); c.call(ch.wet, ch.output);
            c.call(ch.output, ctx.destination);
            ch.params = {
                low: ch.low.gain, hp: ch.hp.frequency, lp: ch.lp.frequency, wet: ch.wet.gain, fb: ch.fb.gain,
                vox: ch.vox.gain, width: ch.wPos.gain, widthNeg: ch.wNeg.gain, level: ch.level.gain,
            };
            return ch;
        }
        function chainFor(ctx, el) {
            if (!el) return null;
            let ch = chains.get(el);
            if (ch && ch.ctx === ctx) return ch;
            if (ch) dropChain(ch);
            ch = buildChain(ctx, el);
            chains.set(el, ch);
            return ch;
        }
        function dropChain(ch) {
            try {
                for (const t of ch.tails) { try { t.disconnect(ch.input); } catch (_) {} try { origConnect.call(t, ch.ctx.destination); } catch (_) {} }
                ch.output.disconnect();
            } catch (_) {}
            chains.delete(ch.el);
        }

        function install() {
            if (!hasWA || installed) return installed;
            try {
                destCtor = typeof AudioDestinationNode !== 'undefined' ? AudioDestinationNode : null;
                origCreate = AudioContext.prototype.createMediaElementSource;
                origConnect = AudioNode.prototype.connect;
                AudioContext.prototype.createMediaElementSource = function (el) {
                    const node = origCreate.apply(this, arguments);
                    try { ctxEl.set(this, el); } catch (_) {}
                    return node;
                };
                // Новые графы плеера: всё, что идёт в динамики, пропускаем через нашу цепочку
                AudioNode.prototype.connect = function (dest) {
                    try {
                        if (isDest(dest) && !this.__xfdjOwn && ctxEl.has(this.context)) {
                            const ch = chainFor(this.context, ctxEl.get(this.context));
                            if (ch && this !== ch.output) {
                                ch.tails.add(this);
                                const rest = Array.prototype.slice.call(arguments, 1);
                                return origConnect.apply(this, [ch.input].concat(rest));
                            }
                        }
                    } catch (_) {}
                    return origConnect.apply(this, arguments);
                };
                installed = true;
            } catch (e) { err('эффекты: установка', e); }
            return installed;
        }

        function uninstall() {
            clearTimers();
            for (const ch of Array.from(chains.values())) { neutral(ch, 0); dropChain(ch); }
            if (installed) {
                try { AudioContext.prototype.createMediaElementSource = origCreate; } catch (_) {}
                try { AudioNode.prototype.connect = origConnect; } catch (_) {}
                installed = false;
            }
        }

        // Уже созданные графы ищем обходом объектов плеера
        const looksLikeGraph = (o) => {
            try {
                return o.sourceNode && o.context && typeof o.context.createGain === 'function' &&
                    o.audioElement && typeof o.audioElement.play === 'function' && (o.r128GainNode || o.gainNode);
            } catch (_) { return false; }
        };
        function attachGraph(g) {
            if (graphsSeen.has(g)) return chains.has(g.audioElement);
            const cfg = g.config;
            if (!cfg || typeof cfg !== 'object') return false;
            const tail = cfg.useGain ? g.gainNode : g.r128GainNode;
            if (!tail) return false;
            graphsSeen.add(g);
            try { ctxEl.set(g.context, g.audioElement); } catch (_) {}
            const ch = chainFor(g.context, g.audioElement);
            if (!ch.tails.has(tail)) {
                tail.disconnect();
                origConnect.call(tail, ch.input);
                ch.tails.add(tail);
            }
            return true;
        }
        function discover(roots) {
            if (!installed) return { found: chains.size, scanned: 0 };
            const seen = new Set();
            const q = [];
            for (const r of roots) if (r) q.push([r, 0]);
            let qi = 0, scanned = 0, found = 0;
            const skip = (o) => (typeof Node !== 'undefined' && o instanceof Node) || o === window ||
                (typeof AudioNode !== 'undefined' && o instanceof AudioNode) ||
                (typeof BaseAudioContext !== 'undefined' && o instanceof BaseAudioContext) ||
                ArrayBuffer.isView(o) || o instanceof ArrayBuffer || o instanceof Promise;
            while (qi < q.length && scanned < 40000) {
                const [o, d] = q[qi++];
                if (seen.has(o)) continue;
                seen.add(o);
                scanned++;
                try {
                    if (skip(o)) continue;
                    if (looksLikeGraph(o)) { if (attachGraph(o)) found++; continue; }
                    if (d >= 8) continue;
                    let vals;
                    if (o instanceof Map) vals = Array.from(o.values()).slice(0, 300);
                    else if (o instanceof Set) vals = Array.from(o).slice(0, 300);
                    else if (Array.isArray(o)) vals = o.length > 300 ? [] : o;
                    else vals = Object.keys(o).slice(0, 200).map(k => { try { return o[k]; } catch (_) { return null; } });
                    for (const v of vals) if (v && typeof v === 'object' && !seen.has(v)) q.push([v, d + 1]);
                } catch (_) {}
            }
            return { found, scanned };
        }

        // ---------- автоматизация ----------
        function hold(ch, param, now) {
            param.cancelScheduledValues(now);
            param.setValueAtTime(param.value, now);
        }
        function apply(ch, steps, t0) {
            const ctx = ch.ctx, now = ctx.currentTime;
            const clampF = (v) => Math.max(10, Math.min(ch.lpMax, v));
            const last = {};   // значение параметра после предыдущего шага
            // Ширина стерео — два параметра с противоположными знаками
            steps = [].concat(...steps.map(s => s.p !== 'width' ? [s] :
                [s, Object.assign({}, s, { p: 'widthNeg', to: -s.to, from: s.from !== undefined ? -s.from : undefined })]));
            for (const s of steps) {
                const param = ch.params[s.p];
                const isF = s.p === 'hp' || s.p === 'lp';
                const to = isF ? clampF(s.to) : s.to;
                const start = t0 + s.at, endT = start + s.dur;
                let from = s.from !== undefined ? (isF ? clampF(s.from) : s.from) : (s.p in last ? last[s.p] : param.value);
                last[s.p] = to;
                if (s.dur > 0 && endT > now) {
                    // Шаг начался в прошлом — продолжаем ту же кривую с текущей точки, конец не сдвигаем
                    if (start < now) {
                        const k = (now - start) / s.dur;
                        from = s.exp ? from * Math.pow(to / from, k) : from + (to - from) * k;
                    }
                    const at = Math.max(now, start);
                    param.setValueAtTime(from, at);
                    if (s.exp) param.exponentialRampToValueAtTime(to, endT);
                    else param.linearRampToValueAtTime(to, endT);
                } else param.setValueAtTime(to, Math.max(now, s.dur > 0 ? endT : start));
            }
        }
        function neutral(ch, ramp, atRel) {
            try {
                const ctx = ch.ctx, now = ctx.currentTime, at = now + (atRel || 0);
                const tc = Math.max(0.01, (ramp || 0) / 3);
                const vals = Object.assign({}, NEUTRAL, { lp: ch.lpMax });
                for (const k of Object.keys(vals)) {
                    const p = ch.params[k];
                    if (!atRel) hold(ch, p, now); else p.cancelScheduledValues(at);
                    if (ramp > 0) p.setTargetAtTime(vals[k], at, tc);
                    else p.setValueAtTime(vals[k], at);
                }
            } catch (e) { err('эффекты: сброс', e); }
        }
        function later(fn, ms) {
            const t = setTimeout(() => { timers.delete(t); try { fn(); } catch (e) { err('эффекты', e); } }, ms);
            timers.add(t);
        }
        function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }

        let current = null;
        function run(plan, opts) {
            // opts: { inEl, outEl, mode, d0 }
            abort(0.05);
            const prog = program(plan, opts);
            if (!prog.out.length && !prog.in.length) return { ok: false, reason: 'выключено' };
            const chOut = chains.get(opts.outEl), chIn = chains.get(opts.inEl);
            if (!chOut || !chIn) return { ok: false, reason: `нет доступа к звуку (${chains.size} графов)` };
            if (chOut === chIn) return { ok: false, reason: 'один и тот же элемент' };
            for (const ch of [chOut, chIn]) {
                const now = ch.ctx.currentTime;
                for (const k of Object.keys(ch.params)) hold(ch, ch.params[k], now);
            }
            if (prog.delay) chOut.delay.delayTime.setValueAtTime(prog.delay, chOut.ctx.currentTime);
            apply(chOut, prog.out, chOut.ctx.currentTime);
            apply(chIn, prog.in, chIn.ctx.currentTime);
            current = { chOut, chIn, prog, startedAt: Date.now(), plan };
            // После перехода всё возвращаем в ноль (эхо — после того как отзвучит хвост)
            later(() => { neutral(chIn, 0.3); }, (prog.end + 0.2) * 1000);
            later(() => {
                const keepEcho = prog.echoTail > 0;
                const ctx = chOut.ctx, now = ctx.currentTime;
                for (const k of Object.keys(chOut.params)) { if (k === 'wet' || k === 'fb') continue; hold(chOut, chOut.params[k], now); chOut.params[k].setTargetAtTime(k === 'lp' ? chOut.lpMax : NEUTRAL[k], now, 0.1); }
                if (!keepEcho) { neutral(chOut, 0.3); current = null; }
            }, (prog.end + 0.2) * 1000);
            if (prog.echoTail > 0) later(() => { neutral(chOut, 1.5); current = null; }, (prog.end + prog.echoTail) * 1000);
            return { ok: true, name: prog.name, end: prog.end };
        }
        // Переход прервали (пауза, «следующий трек») — быстро убираем все эффекты
        function abort(ramp) {
            clearTimers();
            if (!current) return false;
            const c = current;
            current = null;
            neutral(c.chOut, ramp == null ? 0.15 : ramp);
            neutral(c.chIn, ramp == null ? 0.15 : ramp);
            return true;
        }
        const running = () => current;
        const stats = () => ({ supported: hasWA, installed, chains: chains.size, running: !!current });

        return { install, uninstall, discover, run, abort, running, stats, _chains: chains };
    }

    return { program, create, params, PARAMS, LOW_KILL };
})();
if (typeof module !== 'undefined') module.exports = XFEffects;
