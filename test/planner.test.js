// Тест планировщика: анализ двух синтетических треков → план → моделирование перехода.
// Запуск: node test/planner.test.js
const XFAnalysis = require('../src/analysis.js');
const XFPlanner = require('../src/planner.js');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function synth({ bpm, offset, sr = 22050, bars = 64, introBars = 8, outroBars = 8, tailBars = 0, seed = 1, noise = 0.05 }) {
    const beat = 60 / bpm, dur = offset + bars * 4 * beat + 1.5;
    const x = new Float32Array(Math.ceil(dur * sr)); const rand = rng(seed);
    const add = (t0, len, fn) => { const a = Math.floor(t0 * sr), b = Math.min(x.length, a + Math.floor(len * sr)); for (let i = Math.max(0, a); i < b; i++) x[i] += fn((i - a) / sr); };
    for (let bar = 0; bar < bars; bar++) {
        const t = offset + bar * 4 * beat, intro = bar < introBars, outro = bar >= bars - outroBars;
        // tailBars в самом конце — почти тишина (как затухающий хвост у рэп-треков)
        const g = bar >= bars - tailBars ? 0.04 : outro ? 0.35 : 1;
        for (let e = 0; e < 8; e++) add(t + e * beat / 2, 0.05, u => (intro ? 0.8 : g) * 0.15 * (rand() * 2 - 1) * Math.exp(-u * 80));
        if (!intro) {
            for (const kb of [0, 2]) add(t + kb * beat, 0.25, u => g * 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
            for (const sb of [1, 3]) add(t + sb * beat, 0.2, u => g * 0.5 * (rand() * 2 - 1) * Math.exp(-u * 18));
            const f = [55, 65.4, 49, 73.4][bar % 4];
            for (let b = 0; b < 4; b++) add(t + b * beat, beat * 0.9, u => g * 0.25 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u * 50) * Math.exp(-u * 2));
        }
    }
    for (let i = 0; i < x.length; i++) x[i] += noise * (rand() * 2 - 1);
    return { x, sr, beat, offset, introBars, bars, outroBars, tailBars, dur: x.length / sr, tailStart: offset + (bars - tailBars) * 4 * beat };
}

const pairs = [
    [{ bpm: 128, offset: 0.4 }, { bpm: 124, offset: 1.1, seed: 2 }, 'beatmatch'],
    [{ bpm: 140, offset: 0.2 }, { bpm: 70.5, offset: 0.9, seed: 3 }, 'beatmatch'],   // половинный темп
    [{ bpm: 95, offset: 1.3 }, { bpm: 98, offset: 0.0, seed: 4, introBars: 4 }, 'beatmatch'],
    [{ bpm: 90, offset: 0.3 }, { bpm: 128, offset: 0.6, seed: 5 }, 'fade'],             // слишком разные темпы
    [{ bpm: 130, offset: 0.1, tailBars: 6, outroBars: 0 }, { bpm: 91, offset: 0.5, seed: 6 }, 'fade'],   // тихий хвост, как в «ПЁТР 1»
    [{ bpm: 126, offset: 0.7, tailBars: 4, outroBars: 4 }, { bpm: 128, offset: 0.2, seed: 8 }, 'beatmatch'],
    [{ bpm: 100, offset: 0.5 }, { bpm: 115, offset: 0.3, seed: 9 }, 'beatmatch'],   // 15%: только со встречей посередине
];

let failed = 0;
const settingsList = [{ style: 'smooth' }, { style: 'energy', mixBars: 4 }];
for (const [ca, cb, expectKind] of pairs) for (const st of settingsList) {
    const a = synth(ca), b = synth(cb);
    const A = XFAnalysis.analyze(a.x, a.sr), B = XFAnalysis.analyze(b.x, b.sr);
    const p = XFPlanner.plan({ A, B, durA: a.dur, durB: b.dur, settings: st });
    const errs = [];
    if (p.kind !== expectKind) errs.push(`вид ${p.kind}, ожидался ${expectKind}`);

    // точки на началах тактов
    const barErr = (s, t) => { const L = 4 * s.beat; const rel = ((t - s.offset) % L + L) % L; return Math.min(rel, L - rel); };
    // С конца дропа: на такте должен быть конец сведения (там кончается дроп старого), а не начало
    const exitT = p.exitAligned ? p.a.outStop : p.a.outStart;
    if (barErr(a, exitT) > 0.03) errs.push(`выход не на такте (${(barErr(a, exitT) * 1000).toFixed(0)}мс)`);
    if (barErr(b, p.b.inStart) > 0.03) errs.push(`вход не на такте (${(barErr(b, p.b.inStart) * 1000).toFixed(0)}мс)`);
    // фраза: от начала музыки кратно 4 тактам
    const barIdx = (s, t) => Math.round((t - s.offset) / (4 * s.beat)) - s.introBars;
    const exitPhrase = barIdx(a, p.a.outStart), entryPhrase = barIdx(b, p.b.inStart);
    if (!p.exitAligned && exitPhrase % 4 !== 0) errs.push(`выход не на границе фразы (такт ${exitPhrase})`);
    if (entryPhrase % 4 !== 0 && entryPhrase >= 0) errs.push(`вход не на границе фразы (такт ${entryPhrase})`);
    // переход помещается в A
    if (p.a.outStop > a.dur) errs.push('выход за концом трека');
    // наложение должно прийтись на звучащую музыку, а не на тихий хвост
    if (a.tailBars && p.a.outStart + 0.6 * p.mixSec > a.tailStart + 0.05) errs.push(`переход ушёл в тихий хвост (хвост с ${a.tailStart.toFixed(1)}с)`);
    if (Math.abs((p.a.outStop - p.a.outStart) - (p.b.inStop - p.b.inStart)) > 1e-6) errs.push('длины выхода и входа разные');

    // моделирование: B на inStart, когда A на outStart; B играет с rate
    let maxDrift = 0;
    if (p.kind === 'beatmatch') {
        for (let w = 0; w <= p.mixSec; w += 0.01) {
            const tA = p.a.outStart + w, tB = p.b.inStart + p.rate * w;
            // фаза доли в A и в B (в долях от периода стоп-доли A на часах)
            const phA = ((tA - a.offset) / a.beat) % 1;
            // доля B в нормализованной сетке анализа (70 BPM → 140: одна исходная доля = две)
            const beatBNorm = b.beat * cb.bpm / B.bpm;
            const phB = ((((tB - b.offset) / beatBNorm) / p.tempoMultiple) % 1 + 1) % 1;
            let d = Math.abs(phA - phB); d = Math.min(d, 1 - d);
            maxDrift = Math.max(maxDrift, d * a.beat);
        }
        if (maxDrift > 0.025) errs.push(`доли расходятся до ${(maxDrift * 1000).toFixed(0)}мс`);
        // Встреча посередине: оба трека в одном темпе, каждый сдвинут не больше чем на половину разницы
        const tA = (60 / A.period) * p.rateA, tB = (60 / B.period) * p.tempoMultiple * p.rateB;
        if (Math.abs(tA - tB) / tA > 1e-6) errs.push(`темпы при встрече разные: ${tA.toFixed(3)} и ${tB.toFixed(3)}`);
        if (Math.abs(p.rateB / p.rateA - p.rate) > 1e-9) errs.push('rateB/rateA ≠ rate');
        const dev = Math.max(Math.abs(p.rateA - 1), Math.abs(p.rateB - 1)), full = Math.abs(p.rate - 1);
        if (full > 0.005 && dev > 0.6 * full) errs.push(`встреча не посередине (${(dev * 100).toFixed(1)}% из ${(full * 100).toFixed(1)}%)`);
    }
    const ok = errs.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${ca.bpm}→${cb.bpm} [${st.style}${st.mixBars ? ',' + st.mixBars : ''}] ${p.kind}: ` +
        `выход ${p.a.outStart.toFixed(2)}с (фраза ${exitPhrase}, из ${a.dur.toFixed(0)}с), вход ${p.b.inStart.toFixed(2)}с (фраза ${entryPhrase}), ` +
        `${p.mixSec.toFixed(1)}с, темп ×${p.rate.toFixed(3)}${p.kind === 'beatmatch' ? `, встреча ${p.meetBpm} BPM (A ×${p.rateA.toFixed(3)}, B ×${p.rateB.toFixed(3)}), расхождение ${(maxDrift * 1000).toFixed(0)}мс` : ''}` +
        (errs.length ? `\n      ↳ ${errs.join('; ')}` : ''));
}
// Ползунок «длина плавного ухода»: переход не короче заданного, в целых тактах
{
    const a = synth({ bpm: 90, offset: 0.3 }), b = synth({ bpm: 128, offset: 0.6, seed: 5 });
    const A = XFAnalysis.analyze(a.x, a.sr), B = XFAnalysis.analyze(b.x, b.sr);
    for (const fadeSec of [3, 8, 12]) {
        const p = XFPlanner.plan({ A, B, durA: a.dur, durB: b.dur, settings: { fadeSec, toDrop: false } });
        const bars = p.mixSec / (4 * A.period);
        const ok = p.kind === 'fade' && p.mixSec >= fadeSec - 1e-6 && Math.abs(bars - Math.round(bars)) < 1e-6;
        if (!ok) failed++;
        console.log(`${ok ? 'OK  ' : 'FAIL'} длина плавного ухода ${fadeSec} с → ${p.mixSec.toFixed(2)} с (${Math.round(bars)} тактов)`);
    }
}
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе тесты пройдены');
process.exitCode = failed ? 1 : 0;
