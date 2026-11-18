/*
 * Анализ ритма трека.
 * Вход: моно Float32Array и частота дискретизации.
 * Выход: BPM, сетка долей (постоянный темп), фаза начала такта, энергия по тактам.
 *
 * Чистая функция без зависимостей от браузера — тестируется в Node.
 */
/* exported XFAnalysis */
var XFAnalysis = (function () {
    'use strict';

    const HOP = 256;            // шаг кадра в сэмплах
    const MIN_BPM = 60, MAX_BPM = 200;

    // Однополюсный фильтр нижних частот: коэффициент
    function lpCoef(fc, sr) { return 1 - Math.exp(-2 * Math.PI * fc / sr); }

    function onsetEnvelope(x, sr) {
        const n = Math.floor(x.length / HOP);
        const eLow = new Float32Array(n), eMid = new Float32Array(n), eHigh = new Float32Array(n), eAll = new Float32Array(n);
        const zcLow = new Float32Array(n);   // пересечения нуля в басу ≈ высота ноты баса
        const aLow = lpCoef(150, sr), aMid = lpCoef(2000, sr), aSub = lpCoef(250, sr);
        let low = 0, low2 = 0, mid = 0, sub = 0, sub2 = 0, prevSub = 0;
        for (let f = 0; f < n; f++) {
            let sl = 0, sm = 0, sh = 0, sa = 0, zc = 0;
            const base = f * HOP;
            for (let i = 0; i < HOP; i++) {
                const v = x[base + i];
                low += aLow * (v - low);
                low2 += aLow * (low - low2);           // 2-й порядок для баса
                mid += aMid * (v - mid);
                sub += aSub * (v - sub);
                sub2 += aSub * (sub - sub2);
                if ((sub2 >= 0) !== (prevSub >= 0)) zc++;
                prevSub = sub2;
                const bandLow = low2, bandMid = mid - low2, bandHigh = v - mid;
                sl += bandLow * bandLow; sm += bandMid * bandMid; sh += bandHigh * bandHigh; sa += v * v;
            }
            eLow[f] = sl / HOP; eMid[f] = sm / HOP; eHigh[f] = sh / HOP; eAll[f] = sa / HOP;
            zcLow[f] = zc;
        }
        const lg = (e) => { const out = new Float32Array(e.length); let mx = 1e-12; for (let i = 0; i < e.length; i++) mx = Math.max(mx, e[i]); for (let i = 0; i < e.length; i++) out[i] = Math.log(1 + 1000 * e[i] / mx); return out; };
        const L = lg(eLow), M = lg(eMid), H = lg(eHigh);
        const on = new Float32Array(n), onLow = new Float32Array(n);
        for (let f = 1; f < n; f++) {
            const dl = Math.max(0, L[f] - L[f - 1]);
            const dm = Math.max(0, M[f] - M[f - 1]);
            const dh = Math.max(0, H[f] - H[f - 1]);
            onLow[f] = dl;
            on[f] = dl + 0.7 * dm + 0.4 * dh;
        }
        // Вычитаем скользящее среднее (~0.4 с), оставляем только всплески
        const fps = sr / HOP;
        const w = Math.max(3, Math.round(0.4 * fps));
        const norm = (src) => {
            const out = new Float32Array(n);
            let acc = 0;
            for (let f = 0; f < n; f++) {
                acc += src[f];
                if (f >= w) acc -= src[f - w];
                const mean = acc / Math.min(f + 1, w);
                out[f] = Math.max(0, src[f] - mean);
            }
            return out;
        };
        return { on: norm(on), onLow: norm(onLow), energy: eAll, eLow, zcLow, fps, n };
    }

    function sampleAt(arr, pos) {
        const i = Math.floor(pos);
        if (i < 0 || i + 1 >= arr.length) return 0;
        const fr = pos - i;
        return arr[i] * (1 - fr) + arr[i + 1] * fr;
    }

    // Автокорреляция огибающей для оценки периода доли
    function estimatePeriod(on, fps) {
        const minLag = Math.floor(fps * 60 / MAX_BPM), maxLag = Math.ceil(fps * 60 / MIN_BPM);
        const n = on.length;
        const ac = new Float32Array(maxLag * 2 + 2);
        for (let lag = minLag; lag <= Math.min(maxLag * 2 + 1, n - 1); lag++) {
            let s = 0;
            for (let i = lag; i < n; i++) s += on[i] * on[i - lag];
            ac[lag] = s / (n - lag);
        }
        let best = -1, bestLag = minLag;
        for (let lag = minLag; lag <= maxLag; lag++) {
            const bpm = 60 * fps / lag;
            // Мягкий приоритет темпов около 120, плюс поддержка кратных периодов
            const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
            const score = (ac[lag] + 0.5 * (ac[2 * lag] || 0) + 0.25 * (lag % 2 === 0 ? ac[lag / 2] || 0 : 0)) * prior;
            if (score > best) { best = score; bestLag = lag; }
        }
        // Параболическая интерполяция для дробного периода
        const y0 = ac[bestLag - 1] || 0, y1 = ac[bestLag], y2 = ac[bestLag + 1] || 0;
        const denom = y0 - 2 * y1 + y2;
        const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom)) : 0;
        return bestLag + delta;
    }

    // Лучшая фаза сетки для периода P (в кадрах); возвращает {phase, score}
    function bestPhase(on, P, step = 0.25) {
        let best = -1, bestPh = 0;
        for (let ph = 0; ph < P; ph += step) {
            let s = 0, c = 0;
            for (let pos = ph; pos < on.length - 1; pos += P) { s += sampleAt(on, pos); c++; }
            s /= Math.max(1, c);
            if (s > best) { best = s; bestPh = ph; }
        }
        return { phase: bestPh, score: best };
    }

    function analyze(x, sr) {
        const t0 = Date.now();
        const env = onsetEnvelope(x, sr);
        const { on, onLow, energy, eLow, zcLow, fps, n } = env;
        const duration = x.length / sr;
        if (n < fps * 10) return { ok: false, reason: 'трек слишком короткий', duration };

        let P = estimatePeriod(on, fps);
        // Уточняем период и фазу совместно (±0.8%)
        let best = { score: -1 };
        for (let d = -0.008; d <= 0.0081; d += 0.0005) {
            const p = P * (1 + d);
            const r = bestPhase(on, p, 0.5);
            if (r.score > best.score) best = { score: r.score, period: p, phase: r.phase };
        }
        const fine = bestPhase(on, best.period, 0.1);
        P = best.period;
        const phase = fine.phase;

        // Уверенность: среднее на сетке против среднего на сдвинутой на полдоли сетке
        let onGrid = 0, offGrid = 0, cnt = 0;
        for (let pos = phase; pos < n - 1; pos += P) { onGrid += sampleAt(on, pos); offGrid += sampleAt(on, pos + P / 2); cnt++; }
        let mean = 0; for (let i = 0; i < n; i++) mean += on[i]; mean /= n;
        const confidence = (onGrid / cnt) / Math.max(1e-9, mean);
        const halfContrast = (onGrid + 1e-9) / (offGrid + 1e-9);

        let bpm = 60 * fps / P;
        // Нормализуем в диапазон 75–165, чтобы треки сравнивались одинаково
        let period = P / fps;
        while (bpm < 75) { bpm *= 2; period /= 2; }
        while (bpm > 165) { bpm /= 2; period *= 2; }
        const firstBeat = (phase / fps) % period;

        const beats = [];
        for (let t = firstBeat; t < duration - 0.05; t += period) beats.push(t);

        // Энергия по долям и начало музыки
        const frameOf = (t) => Math.max(0, Math.min(n - 1, Math.round(t * fps)));
        const beatEnergy = new Float32Array(beats.length);
        for (let k = 0; k < beats.length; k++) {
            const a = frameOf(beats[k]), b = frameOf(beats[k] + period);
            let s = 0; for (let f = a; f < b; f++) s += energy[f];
            beatEnergy[k] = Math.sqrt(s / Math.max(1, b - a));
        }
        let maxBE = 1e-12; for (const v of beatEnergy) maxBE = Math.max(maxBE, v);
        for (let k = 0; k < beatEnergy.length; k++) beatEnergy[k] /= maxBE;
        // Энергия баса по долям — чтобы найти, где «заходит» бас (дроп, припев)
        const beatLow = new Float32Array(beats.length);
        for (let k = 0; k < beats.length; k++) {
            const a = frameOf(beats[k]), b = frameOf(beats[k] + period);
            let s = 0; for (let f = a; f < b; f++) s += env.eLow[f] || 0;
            beatLow[k] = Math.sqrt(s / Math.max(1, b - a));
        }
        let maxBL = 1e-12; for (const v of beatLow) maxBL = Math.max(maxBL, v);
        for (let k = 0; k < beatLow.length; k++) beatLow[k] /= maxBL;

        // «Нота» баса на каждой доле: средние пересечения нуля, взвешенные энергией баса
        const bassPitch = new Float32Array(beats.length);
        for (let k = 0; k < beats.length; k++) {
            const a = frameOf(beats[k] + period * 0.15), b = frameOf(beats[k] + period * 0.85);
            let s = 0, w = 0;
            for (let f = a; f < b; f++) { s += zcLow[f] * eLow[f]; w += eLow[f]; }
            bassPitch[k] = w > 0 ? s / w : 0;
        }
        let bpMean = 0; for (const v of bassPitch) bpMean += v; bpMean = bpMean / Math.max(1, bassPitch.length) || 1;
        const bassChange = (k) => k > 0 ? Math.abs(bassPitch[k] - bassPitch[k - 1]) / bpMean : 0;

        // Фаза такта (4/4): бочка на «раз» + смена баса + границы секций на начале такта
        const lowAt = (k) => sampleAt(onLow, beats[k] * fps);
        const allAt = (k) => sampleAt(on, beats[k] * fps);
        const barScores = [0, 0, 0, 0];
        for (let j = 0; j < 4; j++) {
            let kick = 0, nov = 0, c = 0;
            for (let k = j; k < beats.length; k += 4) {
                kick += 1.0 * lowAt(k) + 0.3 * allAt(k) + 1.5 * bassChange(k);
                // Новизна: разница энергии такта после и до этой доли
                if (k >= 4 && k + 4 <= beats.length) {
                    let before = 0, after = 0;
                    for (let i = 1; i <= 4; i++) before += beatEnergy[k - i];
                    for (let i = 0; i < 4; i++) after += beatEnergy[k + i];
                    nov += Math.abs(after - before) / 4;
                }
                c++;
            }
            barScores[j] = kick / Math.max(1, c) + 2.0 * nov / Math.max(1, c);
        }
        let downbeatPhase = 0;
        for (let j = 1; j < 4; j++) if (barScores[j] > barScores[downbeatPhase]) downbeatPhase = j;
        const sortedBar = [...barScores].sort((a, b) => b - a);
        const barConfidence = sortedBar[0] / Math.max(1e-9, sortedBar[1]);

        // Энергия по тактам
        const bars = [];
        for (let k = downbeatPhase; k + 4 <= beats.length; k += 4) {
            let e = 0, lo = 0; for (let i = 0; i < 4; i++) { e += beatEnergy[k + i]; lo += beatLow[k + i]; }
            bars.push({ t: beats[k], beat: k, energy: e / 4, low: lo / 4 });
        }
        // Первый «музыкальный» такт: энергия выше 25% от максимума
        let musicStartBar = bars.findIndex(b => b.energy > 0.25);
        if (musicStartBar < 0) musicStartBar = 0;
        // Последний музыкальный такт
        let musicEndBar = bars.length - 1;
        while (musicEndBar > 0 && bars[musicEndBar].energy < 0.15) musicEndBar--;

        const drops = findDrops(bars, musicStartBar, duration);
        const dropEnds = findDropEnds(bars, duration);

        return {
            ok: true,
            version: 3,
            duration,
            bpm: Math.round(bpm * 100) / 100,
            period,
            firstBeat,
            downbeatPhase,
            confidence: Math.round(confidence * 100) / 100,
            halfContrast: Math.round(halfContrast * 100) / 100,
            barConfidence: Math.round(barConfidence * 100) / 100,
            bars: bars.map(b => ({ t: Math.round(b.t * 1000) / 1000, e: Math.round(b.energy * 1000) / 1000, lo: Math.round(b.low * 1000) / 1000 })),
            drops,
            dropEnds,
            musicStartBar,
            musicEndBar,
            ms: Date.now() - t0,
        };
    }

    // Дроп / припев: начало фразы, где после более тихого куска резко растут громкость и бас
    // и дальше держатся высокими. Возвращаем кандидатов по времени (первый — главный).
    function findDrops(bars, start, duration) {
        if (bars.length < 16) return [];
        const mean = (key, i0, i1) => { let s = 0, c = 0; for (let i = Math.max(0, i0); i < Math.min(bars.length, i1); i++) { s += bars[i][key]; c++; } return c ? s / c : 0; };
        const es = bars.map(b => b.energy).sort((a, b) => a - b);
        const loud = es[Math.floor(es.length * 0.8)];
        // Подъём считаем на каждом такте: тихая часть может сдвинуть «начало музыки»,
        // поэтому сетку фраз используем только как небольшой бонус
        const n = bars.length, rise = new Float32Array(n);
        for (let i = 2; i < n - 4; i++) {
            const span = Math.min(8, i);
            const eB = mean('energy', i - span, i), eA = mean('energy', i, i + 8);
            const lB = mean('low', i - span, i), lA = mean('low', i, i + 8);
            rise[i] = (eA - eB) + 1.2 * (lA - lB);
        }
        const out = [];
        for (let i = 2; i < n - 4; i++) {
            if (bars[i].t > Math.min(duration * 0.6, 120)) break;
            // только пик подъёма: дроп — ровно тот такт, где начинается громкая часть
            if (!(rise[i] >= rise[i - 1] && rise[i] > rise[i + 1] && rise[i] >= (rise[i - 2] || 0) && rise[i] >= rise[i + 2])) continue;
            const eA = mean('energy', i, i + 8);
            if (eA < 0.85 * loud || rise[i] < 0.12) continue;
            const rel = i - start;
            const score = rise[i] + (rel >= 0 && rel % 8 === 0 ? 0.04 : 0) + (rel >= 0 && rel % 4 === 0 ? 0.02 : 0);
            out.push({ bar: i, t: Math.round(bars[i].t * 1000) / 1000, score: Math.round(score * 1000) / 1000 });
        }
        // Соседние кандидаты (ближе 4 тактов) — оставляем сильнейший
        const res = [];
        for (const d of out) {
            const prev = res[res.length - 1];
            if (prev && d.bar - prev.bar < 4) { if (d.score > prev.score) res[res.length - 1] = d; }
            else res.push(d);
        }
        return res.slice(0, 4);
    }

    // Конец дропа / припева: такт, где после громкой части резко падают громкость и бас.
    // Ищем во второй половине трека — там, откуда удобно уходить в следующий.
    function findDropEnds(bars, duration) {
        const n = bars.length;
        if (n < 16) return [];
        const mean = (key, i0, i1) => { let s = 0, c = 0; for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) { s += bars[i][key]; c++; } return c ? s / c : 0; };
        const es = bars.map(b => b.energy).sort((a, b) => a - b);
        const loud = es[Math.floor(es.length * 0.8)];
        const fall = new Float32Array(n);
        for (let i = 8; i < n - 2; i++) {
            const after = Math.min(4, n - i);
            fall[i] = (mean('energy', i - 8, i) - mean('energy', i, i + after)) + 1.2 * (mean('low', i - 8, i) - mean('low', i, i + after));
        }
        const out = [];
        for (let i = 8; i < n - 2; i++) {
            if (bars[i].t < Math.max(30, duration * 0.35)) continue;
            if (!(fall[i] >= fall[i - 1] && fall[i] > (fall[i + 1] || 0) && fall[i] >= fall[i - 2] && fall[i] >= (fall[i + 2] || 0))) continue;
            if (mean('energy', i - 8, i) < 0.85 * loud || fall[i] < 0.12) continue;
            out.push({ bar: i, t: Math.round(bars[i].t * 1000) / 1000, score: Math.round(fall[i] * 1000) / 1000 });
        }
        return out;
    }

    return { analyze, findDrops, findDropEnds, HOP };
})();
if (typeof module !== 'undefined') module.exports = XFAnalysis;
