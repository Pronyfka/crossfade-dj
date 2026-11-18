// Готовит данные для демо-скриншота панели: анализ двух синтетических треков.
// Запуск: node assets/src/make-demo-data.js
const fs = require('fs'), path = require('path');
const XFAnalysis = require('../../src/analysis.js');
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function synth({ bpm, offset = 0.2, sr = 22050, sections, seed = 1 }) {
    const beat = 60 / bpm, total = sections.reduce((s, x) => s + x[0], 0);
    const x = new Float32Array(Math.ceil((offset + total * 4 * beat + 1.5) * sr)); const rand = rng(seed);
    const add = (t0, len, fn) => { const a = Math.floor(t0 * sr), b = Math.min(x.length, a + Math.floor(len * sr)); for (let i = Math.max(0, a); i < b; i++) x[i] += fn((i - a) / sr); };
    let bar = 0;
    for (const sec of sections) for (let j = 0; j < sec[0]; j++, bar++) {
        const [, kick, bass, hats, snare] = sec, t = offset + bar * 4 * beat;
        for (let e = 0; e < 8; e++) add(t + e * beat / 2, 0.05, u => hats * 0.15 * (rand() * 2 - 1) * Math.exp(-u * 80));
        for (const kb of [0, 2]) add(t + kb * beat, 0.25, u => kick * 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
        for (const sb of [1, 3]) add(t + sb * beat, 0.2, u => snare * 0.5 * (rand() * 2 - 1) * Math.exp(-u * 18));
        const f = [55, 65.4, 49, 73.4][bar % 4];
        for (let b = 0; b < 4; b++) add(t + b * beat, beat * 0.9, u => bass * 0.35 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u * 50) * Math.exp(-u * 1.5));
    }
    for (let i = 0; i < x.length; i++) x[i] += 0.03 * (rand() * 2 - 1);
    return { x, sr, dur: x.length / sr };
}
const a = synth({ bpm: 126, sections: [[8, 0, 0, 1, 0], [16, 0.45, 0, 1, 0.5], [16, 1, 1, 1, 1], [16, 0.45, 0, 1, 0.5], [16, 1, 1, 1, 1], [8, 0.3, 0.1, 0.5, 0.2]], seed: 21 });
const b = synth({ bpm: 123, sections: [[8, 0, 0, 0.8, 0], [16, 0.45, 0, 1, 0.5], [32, 1, 1, 1, 1], [16, 0.45, 0, 1, 0.5], [16, 1, 1, 1, 1], [8, 0.3, 0.1, 0.5, 0.2]], seed: 22 });
const A = XFAnalysis.analyze(a.x, a.sr), B = XFAnalysis.analyze(b.x, b.sr);
const out = { A, B, durA: a.dur, durB: b.dur };
fs.writeFileSync(path.join(__dirname, 'demo-data.js'), 'window.DEMO = ' + JSON.stringify(out) + ';\n');
console.log(`A: ${A.ok} ${A.bpm} BPM ${A.reason || ""}, концы дропов ${(A.dropEnds || []).map(d => d.t.toFixed(1))}; B: ${B.ok} ${B.bpm} BPM, дропы ${(B.drops || []).map(d => d.t.toFixed(1))}`);
