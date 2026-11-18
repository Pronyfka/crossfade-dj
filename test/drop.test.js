// Тест «сведение до дропа»: трек с тихим вступлением, куплетом без баса и дропом.
// Запуск: node test/drop.test.js
const XFAnalysis = require('../src/analysis.js');
const XFPlanner = require('../src/planner.js');
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// sections: [{bars, kick, bass, hats, snare}] — громкости частей
function synth({ bpm, offset = 0.2, sr = 22050, sections, seed = 1 }) {
    const beat = 60 / bpm, total = sections.reduce((s, x) => s + x.bars, 0);
    const dur = offset + total * 4 * beat + 1.5;
    const x = new Float32Array(Math.ceil(dur * sr)); const rand = rng(seed);
    const add = (t0, len, fn) => { const a = Math.floor(t0 * sr), b = Math.min(x.length, a + Math.floor(len * sr)); for (let i = Math.max(0, a); i < b; i++) x[i] += fn((i - a) / sr); };
    let bar = 0; const marks = [];
    for (const sec of sections) {
        marks.push(offset + bar * 4 * beat);
        for (let j = 0; j < sec.bars; j++, bar++) {
            const t = offset + bar * 4 * beat;
            for (let e = 0; e < 8; e++) add(t + e * beat / 2, 0.05, u => sec.hats * 0.15 * (rand() * 2 - 1) * Math.exp(-u * 80));
            for (const kb of [0, 2]) add(t + kb * beat, 0.25, u => sec.kick * 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
            for (const sb of [1, 3]) add(t + sb * beat, 0.2, u => sec.snare * 0.5 * (rand() * 2 - 1) * Math.exp(-u * 18));
            const f = [55, 65.4, 49, 73.4][bar % 4];
            for (let b = 0; b < 4; b++) add(t + b * beat, beat * 0.9, u => sec.bass * 0.35 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u * 50) * Math.exp(-u * 1.5));
        }
    }
    for (let i = 0; i < x.length; i++) x[i] += 0.03 * (rand() * 2 - 1);
    return { x, sr, beat, offset, dur: x.length / sr, marks };
}
const S = (bars, kick, bass, hats, snare) => ({ bars, kick, bass, hats, snare });
// A: обычный трек
const a = synth({ bpm: 100, sections: [S(8, 0, 0, 1, 0), S(56, 1, 1, 1, 1)], seed: 3 });
// B: вступление 8 тактов (тарелки), куплет 16 (бочка/снейр тихо, без баса), дроп — всё громко
const b = synth({ bpm: 104, sections: [S(8, 0, 0, 0.8, 0), S(16, 0.45, 0, 1, 0.5), S(32, 1, 1, 1, 1), S(8, 0.4, 0.2, 0.6, 0.3)], seed: 7 });
const dropT = b.marks[2];
const A = XFAnalysis.analyze(a.x, a.sr), B = XFAnalysis.analyze(b.x, b.sr);
const d0 = (B.drops || [])[0];
check(!!d0 && Math.abs(d0.t - dropT) < 0.05, `дроп найден: ${d0 ? d0.t.toFixed(2) : '—'} с (на самом деле ${dropT.toFixed(2)} с), кандидаты: ${(B.drops || []).map(d => d.t.toFixed(1) + '/' + d.score).join(', ')}`);

for (const [label, settings] of [['бит в бит', {}], ['бит в бит 16 тактов', { mixBars: 16, maxMixSec: 40 }], ['плавный уход', { maxStretch: 0.01, tempoSync: false }]]) {
    const p = XFPlanner.plan({ A, B, durA: a.dur, durB: b.dur, settings });
    const endB = p.b.inStart + p.mixSec * p.rate;        // где окажется B в конце сведения
    check(p.dropAligned && Math.abs(endB - dropT) < 0.05,
        `${label} (${p.kind}, ${p.mixBars || '—'} тактов): вход ${p.b.inStart.toFixed(2)} с → конец сведения на ${endB.toFixed(2)} с, дроп ${dropT.toFixed(2)} с`);
}
// Дроп слишком рано для 8 тактов — сведение сокращается
const early = synth({ bpm: 104, sections: [S(2, 0, 0, 0.8, 0), S(3, 0.4, 0, 1, 0.4), S(40, 1, 1, 1, 1)], seed: 9 });
const E = XFAnalysis.analyze(early.x, early.sr);
const pe = XFPlanner.plan({ A, B: E, durA: a.dur, durB: early.dur, settings: {} });
const endE = pe.b.inStart + pe.mixSec * pe.rate;
check(pe.dropAligned && pe.mixBars < 8 && Math.abs(endE - early.marks[2]) < 0.05 && pe.b.inStart >= 0,
    `ранний дроп (${early.marks[2].toFixed(1)} с): сведение ${pe.mixBars} тактов, заканчивается на ${endE.toFixed(2)} с`);
// Выключено — как раньше
const off = XFPlanner.plan({ A, B, durA: a.dur, durB: b.dur, settings: { toDrop: false } });
check(!off.dropAligned, `без «до дропа» — обычный вход: ${off.b.inStart.toFixed(2)} с`);
// Старый трек с припевами: сведение заканчивается ровно на конце последнего припева,
// и в этот же момент у нового — дроп
{
    const a2 = synth({ bpm: 100, sections: [S(8, 0, 0, 1, 0), S(16, 0.45, 0, 1, 0.5), S(16, 1, 1, 1, 1), S(16, 0.45, 0, 1, 0.5), S(16, 1, 1, 1, 1), S(8, 0.3, 0.1, 0.5, 0.2)], seed: 11 });
    const lastChorusEnd = a2.marks[5];
    const A2 = XFAnalysis.analyze(a2.x, a2.sr);
    const ends = A2.dropEnds || [];
    check(ends.some(e => Math.abs(e.t - lastChorusEnd) < 0.05), `конец последнего припева найден: ${ends.map(e => e.t.toFixed(1)).join(', ')} (на самом деле ${lastChorusEnd.toFixed(2)} с)`);
    for (const [label, settings] of [['бит в бит', {}], ['плавный уход', { maxStretch: 0.01, tempoSync: false }]]) {
        const p = XFPlanner.plan({ A: A2, B, durA: a2.dur, durB: b.dur, settings });
        const endB = p.b.inStart + p.mixSec * p.rate;
        check(p.exitAligned && Math.abs(p.a.outStop - lastChorusEnd) < 0.05 && p.dropAligned && Math.abs(endB - dropT) < 0.05,
            `${label}: старый — сведение ${p.a.outStart.toFixed(2)}→${p.a.outStop.toFixed(2)} с (конец припева ${lastChorusEnd.toFixed(2)}), новый — дроп на ${endB.toFixed(2)} с (${dropT.toFixed(2)})`);
    }
    const p0 = XFPlanner.plan({ A: A2, B, durA: a2.dur, durB: b.dur, settings: { toDrop: false } });
    check(!p0.exitAligned, `без «до дропа» выход как раньше: ${p0.a.outStart.toFixed(2)} с`);
}
// Трек вступил с середины (на своём дропе) — следующий переход не раньше чем через minPlay секунд
{
    const a3 = synth({ bpm: 100, sections: [S(8, 0, 0, 1, 0), S(16, 0.45, 0, 1, 0.5), S(16, 1, 1, 1, 1), S(16, 0.45, 0, 1, 0.5), S(16, 1, 1, 1, 1), S(8, 0.3, 0.1, 0.5, 0.2)], seed: 11 });
    const A3 = XFAnalysis.analyze(a3.x, a3.sr);
    for (const startA of [0, 60, 100, 140]) {
        for (const [label, settings] of [['бит в бит', {}], ['плавный уход', { maxStretch: 0.01, tempoSync: false }], ['без до дропа', { toDrop: false }]]) {
            const p = XFPlanner.plan({ A: A3, B, durA: a3.dur, durB: b.dur, settings, startA });
            const need = Math.min(startA + 60, a3.dur - p.mixSec - 1);
            const played = p.a.outStart - startA;
            check(p.a.outStart >= need - 2.5 && p.a.outStop <= a3.dur,
                `вступил на ${startA} с [${label}]: уход с ${p.a.outStart.toFixed(1)} с — трек звучал сам ${played.toFixed(0)} с (трек ${a3.dur.toFixed(0)} с)`);
        }
    }
    // Вход по дропу не выбирается, если после дропа почти ничего не остаётся
    const shortB = synth({ bpm: 104, sections: [S(8, 0, 0, 0.8, 0), S(16, 0.45, 0, 1, 0.5), S(14, 1, 1, 1, 1)], seed: 13 });
    const SB = XFAnalysis.analyze(shortB.x, shortB.sr);
    const ps = XFPlanner.plan({ A, B: SB, durA: a.dur, durB: shortB.dur, settings: {} });
    check(!ps.dropAligned, `после дропа осталось ${(shortB.dur - shortB.marks[2]).toFixed(0)} с — вход по дропу не используется (вход ${ps.b.inStart.toFixed(1)} с)`);
}
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе тесты пройдены');
process.exitCode = failed ? 1 : 0;
