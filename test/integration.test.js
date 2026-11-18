// Интеграционный тест: собранный dist/script.js в поддельном окружении плеера.
// Запуск: node build.js && node test/integration.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function synth({ bpm, offset, sr = 22050, bars = 56, introBars = 8, outroBars = 8, seed = 1 }) {
    const beat = 60 / bpm, dur = offset + bars * 4 * beat + 1.5;
    const x = new Float32Array(Math.ceil(dur * sr)); const rand = rng(seed);
    const add = (t0, len, fn) => { const a = Math.floor(t0 * sr), b = Math.min(x.length, a + Math.floor(len * sr)); for (let i = Math.max(0, a); i < b; i++) x[i] += fn((i - a) / sr); };
    for (let bar = 0; bar < bars; bar++) {
        const t = offset + bar * 4 * beat, intro = bar < introBars, outro = bar >= bars - outroBars, g = outro ? 0.35 : 1;
        for (let e = 0; e < 8; e++) add(t + e * beat / 2, 0.05, u => (intro ? 0.8 : g) * 0.15 * (rand() * 2 - 1) * Math.exp(-u * 80));
        if (!intro) {
            for (const kb of [0, 2]) add(t + kb * beat, 0.25, u => g * 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
            for (const sb of [1, 3]) add(t + sb * beat, 0.2, u => g * 0.5 * (rand() * 2 - 1) * Math.exp(-u * 18));
            const f = [55, 65.4, 49, 73.4][bar % 4];
            for (let b = 0; b < 4; b++) add(t + b * beat, beat * 0.9, u => g * 0.25 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u * 50) * Math.exp(-u * 2));
        }
    }
    return { x, sr, dur: x.length / sr, beat, offset };
}

const tracks = { A: synth({ bpm: 128, offset: 0.4, seed: 2 }), B: synth({ bpm: 124, offset: 1.1, seed: 3 }) };

// ---- поддельный плеер ----
const obs = (v) => { const ls = new Set(); return { get value() { return v; }, set value(n) { v = n; ls.forEach(f => f(n)); }, onChange(f) { ls.add(f); return () => ls.delete(f); } }; };
class FakeAudio {
    constructor(name) { this.name = name; this._pos = 0; this._rate = 1; this._at = Date.now(); this.paused = false; this.ended = false; this.preservesPitch = true; }
    _sync() { const now = Date.now(); if (!this.paused) this._pos += (now - this._at) / 1000 * this._rate; this._at = now; }
    get currentTime() { this._sync(); return this._pos; }
    set currentTime(v) { this._sync(); this._pos = v; }
    get playbackRate() { return this._rate; }
    set playbackRate(r) { this._sync(); this._rate = r; }
}
class Pair { constructor(id, title, durationMs, fade, url) { this.entity = { data: { meta: { id, title, durationMs, type: 'music', fade, artists: [{ name: 'Test' }] } }, mediaSourceData: { data: { urls: [url], codec: 'aac', transport: 'raw' } } }; } }
Pair.prototype.getCrossParams = function () { return this.entity.data.meta.fade; };
Pair.prototype.canBeCrossedWith = function () { return false; };

const elA = new FakeAudio('A');
const engine = {
    isEnabled: obs(false), isCrossing: obs(false), config: { useCrossfade: true },
    currentAudioElement: obs(elA),
    logger: { log() {} },
    tracking: [],
    stopCrossing() { this.stopped = (this.stopped || 0) + 1; },
    forceStopCrossfade() {},
    startTimeTracking(cur, next) {
        const r = cur.getCrossParams(), a = next.getCrossParams();
        this.pulseSyncCrossfadePlan = { currentPair: cur, nextPair: next, currentParams: r, nextParams: a };
        this.tracking.push({ cur: r, next: a, can: cur.canBeCrossedWith(next) });
    },
    // как в движке Яндекса
    getCrossingStartPosition(e, t) { const i = e.outStop - e.outStart, r = t.inStop - t.inStart; return i > r ? Math.max(0, t.inStart - (i - r)) : Math.max(0, t.inStart - 1); },
    isGaplessEnabled() { return true; },
    prepared: [],
    preparedPlayback: null,
    preparePlayback(pair, pos) { this.prepared.push(pos); this.preparedPlayback = { pair, positionSec: pos, controller: { signal: { aborted: false } } }; return Promise.resolve({ ready: true }); },
};
const pairA = new Pair(1, 'Трек A', Math.round(tracks.A.dur * 1000), { inStart: 0, inStop: 2, outStart: tracks.A.dur - 4, outStop: tracks.A.dur - 0.5 }, 'synth://A');
const pairB = new Pair(2, 'Трек B', Math.round(tracks.B.dur * 1000), { inStart: 0, inStop: 1.5, outStart: tracks.B.dur - 4, outStop: tracks.B.dur }, 'synth://B');
const queueState = { currentEntity: obs(pairA), nextEntity: obs(pairB) };

// ---- поддельное окружение браузера ----
const store = new Map();
const elements = [];
const mkEl = () => { const el = { id: '', className: '', innerHTML: '', isConnected: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.isConnected = false; } }; elements.push(el); return el; };
const document = { body: { appendChild(el) { el.isConnected = true; } }, createElement: mkEl, getElementById: (id) => elements.find(e => e.id === id && e.isConnected) || null };
const sandbox = {
    console: { log() {}, warn: (...a) => console.warn('  warn:', ...a.slice(0, 2)) },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Map, Set, WeakSet, WeakMap, Float32Array, Uint8Array, ArrayBuffer, Object, Array, Number, String, Error, isFinite,
    document, Node: class {},
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => ({ url, byteLength: 1000 }) }),
    OfflineAudioContext: class { constructor(c, l, sr) { this.sr = sr; } async decodeAudioData(buf) { const t = tracks[buf.url.split('//')[1]]; return { length: t.x.length, numberOfChannels: 1, sampleRate: t.sr, getChannelData: () => t.x }; } },
    crypto: {},
};
sandbox.window = sandbox;
sandbox.pulsesyncApi = { playerInstance: { state: { currentMediaPlayer: obs(engine), mediaPlayersStore: obs({ audio: engine }), queueState } } };
vm.createContext(sandbox);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

(async () => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'script.js'), 'utf8'), sandbox);
    const X = sandbox.__xfdj;
    check('аддон загрузился', !!X);
    check('встроенный кроссфейд включён', engine.isEnabled.value === true);
    for (let i = 0; i < 40 && !X.state.plan; i++) { await sleep(100); X.tick(); }
    const plan = X.state.plan;
    check('план построен', !!plan, plan && `${plan.kind}, ${plan.reason}`);
    if (!plan) return finish();
    check('вид плана — бит в бит', plan.kind === 'beatmatch');
    const pA = pairA.getCrossParams(), pB = pairB.getCrossParams();
    check('выход A подставлен', Math.abs(pA.outStart - plan.a.outStart) < 1e-9 && Math.abs(pA.outStop - plan.a.outStop) < 1e-9, `${pA.outStart.toFixed(2)}→${pA.outStop.toFixed(2)}`);
    check('вход B подставлен', Math.abs(pB.inStart - plan.b.inStart) < 1e-9, `${pB.inStart.toFixed(2)}→${pB.inStop.toFixed(2)}`);
    check('inStop A поднят (защита от раннего обрыва)', pA.inStop >= Math.min(plan.b.inStart, plan.a.outStart - 1.5) - 1e-9, `inStop=${pA.inStop.toFixed(2)}`);
    check('разрешено пересечение A→B', pairA.canBeCrossedWith(pairB) === true);
    check('движок перезапущен с нашими точками', engine.tracking.length > 0 && engine.tracking[engine.tracking.length - 1].cur.__xfdj === true);
    const pl = engine.pulseSyncCrossfadePlan;
    const expectPos = engine.getCrossingStartPosition(pl.currentParams, pl.nextParams);
    check('следующий трек переподготовлен с точки входа', engine.prepared.length > 0 && Math.abs(engine.prepared[engine.prepared.length - 1] - expectPos) < 1e-9,
        `позиция ${engine.prepared.length ? engine.prepared[engine.prepared.length - 1].toFixed(2) : '—'}, ожидалась ${expectPos.toFixed(2)}`);
    const beatA = tracks.A.beat;
    const onBar = (t, s) => { const L = 4 * s.beat; const r = ((t - s.offset) % L + L) % L; return Math.min(r, L - r) < 0.03; };
    check('выход на начале такта', onBar(plan.a.outStart, tracks.A));
    check('вход на начале такта', onBar(plan.b.inStart, tracks.B));

    // ---- темп старого трека плавно идёт к темпу встречи до перехода ----
    check('темпы встречаются посередине', plan.rateA < 1 && plan.rateB > 1 && Math.abs(plan.rateB / plan.rateA - plan.rate) < 1e-9,
        `встреча ${plan.meetBpm} BPM: A ×${plan.rateA.toFixed(4)}, B ×${plan.rateB.toFixed(4)}`);
    const rampLen = plan.rampBars * 4 * plan.beatPeriodA;
    elA.currentTime = plan.a.outStart - rampLen - 3;
    await sleep(400);
    check('до окна подгонки темп старого не тронут', elA.playbackRate === 1);
    elA.currentTime = plan.a.outStart - rampLen / 2;
    await sleep(1200);
    const midRate = elA.playbackRate, midTarget = 1 + (plan.rateA - 1) * 0.5;
    check('на середине окна старый трек на полпути к темпу встречи', Math.abs(midRate - midTarget) < 0.003, `×${midRate.toFixed(4)}, ожидалось ≈×${midTarget.toFixed(4)}`);
    elA.currentTime = plan.a.outStart - 0.2;
    await sleep(1200);
    check('к точке выхода старый трек в темпе встречи', Math.abs(elA.playbackRate - plan.rateA) < 0.002, `×${elA.playbackRate.toFixed(4)}`);

    // ---- моделируем переход с ошибкой старта 90 мс ----
    const outEl = elA; outEl.currentTime = plan.a.outStart - 1;
    const inEl = new FakeAudio('B'); inEl.currentTime = plan.b.inStart - 1 + 0.09;  // B стартовал на 90 мс позже нужного
    engine.crossOutMediaPlayer = { currentAudioElement: obs(outEl) };
    engine.crossInMediaPlayer = { currentAudioElement: obs(inEl) };
    queueState.currentEntity.value = pairB;
    engine.logger.log('event', 'Проигрывание с пересечением | стартует: B', {});
    engine.stopCrossing();                       // «старый таймер» пытается оборвать
    check('ранний обрыв заблокирован', !engine.stopped);
    engine.isCrossing.value = true;
    const errAt = () => { const target = plan.b.inStart + plan.rate * (outEl.currentTime - plan.a.outStart); return (inEl.currentTime - target) / plan.rate; };
    const e0 = errAt();
    await sleep(3500);
    const e1 = errAt();
    check('подгонка темпа сводит доли', Math.abs(e1) < 0.005, `было ${(e0 * 1000).toFixed(0)} мс → стало ${(e1 * 1000).toFixed(1)} мс, rate=${inEl.playbackRate.toFixed(4)}`);
    check('оба трека в темпе встречи', Math.abs(outEl.playbackRate - plan.rateA) < 0.001 && Math.abs(inEl.playbackRate - plan.rateB) < 0.003,
        `A ×${outEl.playbackRate.toFixed(4)} (нужно ${plan.rateA.toFixed(4)}), B ×${inEl.playbackRate.toFixed(4)} (нужно ${plan.rateB.toFixed(4)})`);
    // Точность в установившемся режиме: 2 с замеров
    let worst = 0;
    for (let i = 0; i < 20; i++) { await sleep(100); worst = Math.max(worst, Math.abs(errAt())); }
    check('доли держатся вместе', worst < 0.004, `худшее расхождение ${(worst * 1000).toFixed(1)} мс за 2 с`);
    // Как в реальном плеере: после перехода уходящий трек встаёт на паузу
    outEl.paused = true;
    engine.isCrossing.value = false;
    await sleep(700);
    check('после перехода начат возврат темпа (уходящий на паузе)', X.state.sync && X.state.sync.phase === 'release');
    await sleep(1500);
    check('темп возвращается к 1', inEl.playbackRate < plan.rate - 0.002, `rate=${inEl.playbackRate.toFixed(4)}`);

    // ---- «плавный уход», а плеер запустил следующий трек с начала вместо 0:10 ----
    const pairC = new Pair(3, 'Трек C', 120000, { inStart: 0, inStop: 1, outStart: 100, outStop: 110 }, 'synth://A');
    X.state.plan = { kind: 'fade', curId: '2', nextId: '3', a: { outStart: 50, outStop: 55.5 }, b: { inStart: 11, inStop: 16.5 }, mixSec: 5.5, rate: 1, reason: 'тест' };
    const out2 = inEl; out2.paused = false; out2.playbackRate = 1; out2.currentTime = 49;   // B уходит, на outStart-1
    const in2 = new FakeAudio('C'); in2.currentTime = 0;                                     // ошибка: старт с нуля
    engine.crossOutMediaPlayer = { currentAudioElement: obs(out2) };
    engine.crossInMediaPlayer = { currentAudioElement: obs(in2) };
    queueState.currentEntity.value = pairC;
    engine.logger.log('event', 'Проигрывание с пересечением | стартует: C', {});
    check('прошлая подгонка темпа сброшена', inEl.playbackRate === 1);
    await sleep(900);
    const exp2 = 11 + (out2.currentTime - 50);
    check('страж поставил следующий трек на точку входа', Math.abs(in2.currentTime - exp2) < 0.2, `C на ${in2.currentTime.toFixed(2)} с, нужно ${exp2.toFixed(2)} с`);
    X.dispose();
    check('выключение вернуло движок как был', engine.isEnabled.value === false);
    finish();
})().catch(e => { console.error(e); process.exitCode = 1; });

function finish() {
    const bad = checks.filter(x => !x).length;
    console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : '\nВсе проверки пройдены');
    process.exitCode = bad ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 50);
}
