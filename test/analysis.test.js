// Тест анализа ритма на синтетических треках с известными параметрами.
// Запуск: node test/analysis.test.js
const XFAnalysis = require('../src/analysis.js');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Синтетический трек: вступление (хэты + пэд), основная часть (бочка 1 и 3, снейр 2 и 4,
// хэты восьмыми, бас), тихий конец. Первая доля такта — на offset секунд.
function synth({ bpm, offset, sr = 22050, bars = 48, introBars = 8, outroBars = 8, seed = 1, swingKick = false, noise = 0 }) {
    const beat = 60 / bpm;
    const dur = offset + bars * 4 * beat + 2;
    const x = new Float32Array(Math.ceil(dur * sr));
    const rand = rng(seed);
    const add = (t0, len, fn) => {
        const a = Math.floor(t0 * sr), b = Math.min(x.length, a + Math.floor(len * sr));
        for (let i = Math.max(0, a); i < b; i++) x[i] += fn((i - a) / sr);
    };
    const kick = (t, g = 1) => add(t, 0.25, u => g * 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
    const snare = (t, g = 1) => add(t, 0.2, u => g * 0.5 * (rand() * 2 - 1) * Math.exp(-u * 18));
    const hat = (t, g = 1) => add(t, 0.05, u => g * 0.15 * (rand() * 2 - 1) * Math.exp(-u * 80));
    const bass = (t, f, g = 1) => add(t, beat * 0.9, u => g * 0.25 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u * 50) * Math.exp(-u * 2));
    // фоновой пэд по всему треку (не ритмичный)
    for (let i = 0; i < x.length; i++) x[i] += 0.03 * Math.sin(2 * Math.PI * 220 * i / sr) * (0.6 + 0.4 * Math.sin(i / sr * 0.3));

    for (let bar = 0; bar < bars; bar++) {
        const t = offset + bar * 4 * beat;
        const intro = bar < introBars, outro = bar >= bars - outroBars;
        const g = outro ? 0.35 : 1;
        for (let e = 0; e < 8; e++) hat(t + e * beat / 2, intro ? 0.8 : g);
        if (!intro) {
            kick(t, g); kick(t + 2 * beat + (swingKick ? beat / 2 : 0), g * 0.8);
            snare(t + beat, g); snare(t + 3 * beat, g);
            const notes = [55, 55, 65.4, 49];
            // бас меняет ноту на начале каждого такта (как гармония в реальной музыке)
            for (let b = 0; b < 4; b++) bass(t + b * beat, notes[bar % 4], g);
        }
    }
    if (noise) for (let i = 0; i < x.length; i++) x[i] += noise * (rand() * 2 - 1);
    return { x, sr, beat, firstDownbeat: offset, introBars, bars, outroBars };
}

const cases = [
    { bpm: 128, offset: 0.37 },
    { bpm: 140, offset: 1.12 },
    { bpm: 95, offset: 0.05 },
    { bpm: 87, offset: 2.4 },
    { bpm: 160, offset: 0.66 },
    { bpm: 104, offset: 0.9, swingKick: true },
    { bpm: 121.5, offset: 0.21, seed: 7 },
    { bpm: 140, offset: 0.5, introBars: 0, outroBars: 0, noise: 0.15 },
    { bpm: 92, offset: 1.7, introBars: 0, noise: 0.25, seed: 11 },
    { bpm: 132, offset: 0.0, introBars: 4, noise: 0.3, seed: 5 },
];

let failed = 0;
for (const c of cases) {
    const s = synth({ introBars: 8, outroBars: 8, ...c, seed: c.seed || 3 });
    const r = XFAnalysis.analyze(s.x, s.sr);
    // нормализованный ожидаемый BPM (диапазон 75–165)
    let exp = c.bpm; while (exp < 75) exp *= 2; while (exp > 165) exp /= 2;
    const bpmErr = Math.abs(r.bpm - exp) / exp;
    // ошибка фазы долей: расстояние истинных долей до ближайшей найденной
    const period = r.period;
    let phaseErr = 0, cnt = 0;
    for (let k = 0; k < s.bars * 4; k++) {
        const t = s.firstDownbeat + k * s.beat;
        const rel = ((t - r.firstBeat) % period + period) % period;
        phaseErr = Math.max(phaseErr, Math.min(rel, period - rel));
        cnt++;
    }
    // такт: найденные начала тактов должны совпадать с истинными «раз»
    const barErr = r.bars.slice(2, -2).map(b => {
        const rel = ((b.t - s.firstDownbeat) % (4 * s.beat) + 4 * s.beat) % (4 * s.beat);
        return Math.min(rel, 4 * s.beat - rel);
    });
    const maxBarErr = Math.max(...barErr);
    const musicStartT = r.bars[r.musicStartBar] && r.bars[r.musicStartBar].t;
    const expMusicStart = s.firstDownbeat + s.introBars * 4 * s.beat;
    const ok = bpmErr < 0.005 && phaseErr < 0.03 && maxBarErr < 0.05;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} bpm ${c.bpm} → ${r.bpm} (ош. ${(bpmErr * 100).toFixed(2)}%), ` +
        `фаза ±${(phaseErr * 1000).toFixed(0)}мс, такт ±${(maxBarErr * 1000).toFixed(0)}мс, ` +
        `увер. ${r.confidence}/${r.barConfidence}, начало музыки ${musicStartT && musicStartT.toFixed(2)}с (ожид. ${expMusicStart.toFixed(2)}), ` +
        `${r.ms}мс`);
}
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе тесты пройдены');
process.exitCode = failed ? 1 : 0;
