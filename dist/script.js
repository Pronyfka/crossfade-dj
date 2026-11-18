/* Crossfade DJ 1.0.0 — Pronyfka. Лицензия MIT. Собрано 2026-11-18 */
(function () {
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


/*
 * Планировщик перехода A → B.
 * Вход: анализ A и B (из XFAnalysis), длительности, настройки и (необязательно)
 * точки Яндекса. Выход: точки для движка + коэффициент темпа для входящего трека.
 *
 * Движок Яндекса при равной длине выхода и входа запускает B с позиции inStart-1
 * в момент, когда A на outStart-1. Значит, B окажется на inStart ровно тогда,
 * когда A на outStart: ставим обе точки на начало такта — получаем «бит в бит».
 */
/* exported XFPlanner */
var XFPlanner = (function () {
    'use strict';

    const DEFAULTS = {
        mixBars: 'auto',      // 'auto' | 4 | 8 | 16
        style: 'smooth',      // 'smooth' — B с первой сильной доли; 'energy' — B с подъёма энергии
        tempoSync: true,      // подстраивать темп B под A на время перехода
        maxStretch: 0.10,     // максимум изменения темпа одного трека (10%)
        tempoSplit: true,     // темпы встречаются посередине: каждый трек меняется на половину разницы
        rampBars: 8,          // за сколько тактов до перехода старый трек плавно меняет темп
        toDrop: true,         // сведение заканчивается ровно на дропе/припеве нового трека
        minPlay: 60,          // каждый трек звучит сам не меньше стольких секунд после того, как вступил
        minMixSec: 4,
        maxMixSec: 24,
        fallbackSec: 6,       // длина обычного перехода, если ритм не определился
        fadeSec: 4.5,         // минимальная длина «плавного ухода» (в целых тактах)
    };

    const usable = (an) => an && an.ok && an.confidence >= 2.5 && an.bars && an.bars.length >= 8;

    // Отношение темпов с учётом кратности (70 и 140 BPM — один темп)
    function tempoRatio(bpmA, bpmB) {
        let best = null;
        for (const m of [0.5, 1, 2]) {
            const r = bpmA / (bpmB * m);
            if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best.r))) best = { r, m };
        }
        return best;
    }

    function phraseScore(barIdxFromStart) {
        if (barIdxFromStart < 0) return -1;
        if (barIdxFromStart % 16 === 0) return 3.5;
        if (barIdxFromStart % 8 === 0) return 3;
        if (barIdxFromStart % 4 === 0) return 1.5;
        if (barIdxFromStart % 2 === 0) return 0.3;
        return 0;
    }
    const meanE = (bars, i0, i1) => {
        let s = 0, c = 0;
        for (let i = Math.max(0, i0); i < Math.min(bars.length, i1); i++) { s += bars[i].e; c++; }
        return c ? s / c : 0;
    };

    function chooseBars(settings, bpm) {
        const barSec = 4 * 60 / bpm;
        let bars = settings.mixBars === 'auto' ? 8 : Number(settings.mixBars) || 8;
        while (bars * barSec > settings.maxMixSec && bars > 1) bars /= 2;
        while (bars * barSec < settings.minMixSec && bars < 32) bars *= 2;
        return { bars, sec: bars * barSec };
    }

    // Точка выхода в A: начало фразы ближе к концу; бонус, если дальше энергия падает (аутро)
    // Конец «звучащей» музыки: после последнего громкого такта идёт затухание/тишина
    function audibleEnd(A, durA) {
        const bars = A.bars;
        let i = bars.length - 1;
        while (i > 0 && bars[i].e < 0.3) i--;
        return Math.min(durA, bars[i].t + 4 * A.period);
    }

    // Выход так, чтобы сведение закончилось ровно на конце дропа/припева старого трека:
    // дроп доигрывает до конца, и в этот момент вступает дроп нового.
    // Берём самый поздний подходящий конец — чтобы старый трек прозвучал как можно полнее.
    function dropEndExit(A, durA, mixSec, minStart) {
        const ends = (A.dropEnds || []).filter(e => e.t - mixSec >= Math.max(20, durA * 0.3, minStart || 0) && e.t <= durA - 0.4);
        if (!ends.length) return null;
        const e = ends[ends.length - 1];
        return { t: e.t - mixSec, bar: null, end: e.t };
    }

    function pickExit(A, durA, mixSec, yandexOut, minStart) {
        const bars = A.bars;
        // Минимум 60% перехода уходящий трек должен звучать, а не тихо затухать
        const hardLatest = durA - mixSec - 0.4;
        let latestStart = Math.min(hardLatest, audibleEnd(A, durA) - 0.6 * mixSec);
        // Трек зазвучал поздно — минимальное время звучания важнее, чем «не уходить на тихом аутро»
        if (minStart && minStart > latestStart) latestStart = Math.min(hardLatest, minStart);
        // Не раньше, чем трек отзвучал своё минимальное время (если он вступил с середины)
        const earliest = Math.min(Math.max(durA * 0.55, durA - 90, minStart || 0), latestStart);
        let best = null;
        for (let i = 0; i < bars.length; i++) {
            const t = bars[i].t;
            if (t < earliest || t > latestStart) continue;
            const rel = i - A.musicStartBar;
            const mixBars = Math.max(1, Math.round(mixSec / (4 * A.period)));
            let score = phraseScore(rel);
            const before = meanE(bars, i - 4, i), during = meanE(bars, i, i + mixBars);
            if (before > 0) score += 2.0 * Math.max(0, (before - during) / before);   // начинаем на спаде
            score -= 0.035 * (latestStart - t);                                         // не выкидываем много трека
            if (yandexOut && Number.isFinite(yandexOut.outStart) && Math.abs(t - yandexOut.outStart) < mixSec) score += 0.8;
            if (i > A.musicEndBar) score -= 1;                                          // уже тишина
            if (!best || score > best.score) best = { t, bar: i, score };
        }
        if (!best) {
            // Места почти нет — уходим как можно позже, на последнем подходящем такте
            for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t <= latestStart) { best = { t: bars[i].t, bar: i, score: 0 }; break; }
        }
        return best;
    }

    // Точка входа в B: начало фразы в начале трека
    function pickEntry(B, durB, mixSec, style) {
        const bars = B.bars;
        const s = B.musicStartBar;
        const limit = Math.min(durB * 0.4, 70);
        let best = null;
        for (let i = 0; i < bars.length; i++) {
            const t = bars[i].t;
            if (t > limit) break;
            if (t + mixSec > durB - 20) break;
            const rel = i - s;
            let score = phraseScore(rel);
            if (rel < 0) score -= 2;
            const after = meanE(bars, i, i + 4), before = meanE(bars, i - 4, i);
            if (style === 'energy') {
                score += 3 * Math.max(0, after - before);    // ищем подъём / дроп
                score -= 0.01 * t;
            } else {
                score -= 0.06 * Math.max(0, t - bars[s].t); // как можно раньше после вступления
                if (rel === 0) score += 1.5;
            }
            if (!best || score > best.score) best = { t, bar: i, score };
        }
        return best;
    }

    // Вход так, чтобы конец сведения (lenB секунд трека B) пришёлся ровно на дроп.
    // onBar — вход тоже на начале такта (для «бит в бит» это выполняется само собой).
    function dropEntry(B, durB, lenB, onBar, minTail) {
        const drops = B.drops || [];
        for (const d of drops) {
            let t = d.t - lenB;
            if (t < -0.05 || d.t + Math.max(10, minTail || 0) > durB) continue;
            t = Math.max(0, t);
            if (onBar) {
                let best = null;
                for (const b of B.bars) if (!best || Math.abs(b.t - t) < Math.abs(best.t - t)) best = b;
                if (best && Math.abs(best.t - t) < 0.12) t = best.t;
            }
            return { t, drop: d };
        }
        return null;
    }
    const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    function fallbackPlan(durA, durB, settings, reason, yandexA, yandexB) {
        const L = settings.fallbackSec;
        // Точки Яндекса знают, где у трека начинается затухание — опираемся на них
        const yEnd = yandexA && Number.isFinite(yandexA.outStart) ? yandexA.outStart + Math.min(2, L / 2) : NaN;
        const outStop = Math.max(L + 1, Number.isFinite(yEnd) ? Math.min(yEnd, durA - 0.3) : durA - 0.3);
        const inStart = yandexB && Number.isFinite(yandexB.inStart) ? yandexB.inStart : 0;
        return {
            kind: 'smooth',
            reason,
            mixSec: L,
            a: { outStart: outStop - L, outStop },
            b: { inStart, inStop: inStart + L },
            rate: 1,
        };
    }

    function plan({ A, B, durA, durB, settings: s, yandexA, yandexB, startA }) {
        const settings = Object.assign({}, DEFAULTS, s || {});
        // startA — с какого места текущий трек зазвучал сам (после прошлого перехода).
        // Уходить с него раньше, чем через minPlay секунд, нельзя.
        const minStart = Number.isFinite(startA) && startA > 0 ? startA + settings.minPlay : 0;
        const minTail = settings.minPlay + 20;   // сколько нового трека должно остаться после его дропа
        if (!Number.isFinite(durA) || !Number.isFinite(durB) || durA < 20 || durB < 20) {
            return fallbackPlan(durA, durB, settings, 'нет длительности', yandexA, yandexB);
        }
        if (!usable(A) || !usable(B)) {
            return fallbackPlan(durA, durB, settings, !usable(A) ? 'ритм текущего не определён' : 'ритм следующего не определён', yandexA, yandexB);
        }
        // Точное отношение — по периоду доли, а не по округлённому BPM
        const tr = tempoRatio(A.period ? 60 / A.period : A.bpm, B.period ? 60 / B.period : B.bpm);
        const split = settings.tempoSync && settings.tempoSplit;
        // При встрече посередине каждый трек меняется на √r — вдвое меньше на слух
        const perTrack = split ? Math.abs(Math.sqrt(tr.r) - 1) : Math.abs(tr.r - 1);
        const stretch = Math.abs(tr.r - 1);
        const beatmatch = perTrack <= settings.maxStretch && (settings.tempoSync || stretch <= 0.012);
        if (!beatmatch) {
            // Темпы слишком разные: короткий плавный переход в целых тактах (не короче 4.5 с)
            const barSec = 4 * A.period;
            let shortSec = Math.max(1, Math.ceil(settings.fadeSec / barSec)) * barSec;
            // До дропа: длина ухода — целое число тактов НОВОГО трека, тогда и вход на такте,
            // и конец ровно на дропе
            let de = null;
            if (settings.toDrop) {
                const barB = 4 * B.period;
                const secB = Math.max(1, Math.ceil(settings.fadeSec / barB)) * barB;
                de = dropEntry(B, durB, secB, true, minTail);
                if (de) shortSec = secB;
            }
            const xe = settings.toDrop ? dropEndExit(A, durA, shortSec, minStart) : null;
            const exit = xe || pickExit(A, durA, shortSec, yandexA, minStart);
            const entry = de ? { t: de.t, bar: null } : pickEntry(B, durB, shortSec, settings.style);
            if (!exit || !entry) return fallbackPlan(durA, durB, settings, 'не нашлось тактов', yandexA, yandexB);
            return {
                kind: 'fade',
                reason: `темпы далеко: ${A.bpm} и ${B.bpm} BPM` + (xe ? `, с конца дропа в ${fmtT(xe.end)}` : '') + (de ? `, до дропа в ${fmtT(de.drop.t)}` : ''),
                dropAligned: !!de, dropT: de ? de.drop.t : null,
                exitAligned: !!xe,
                mixSec: shortSec,
                a: { outStart: exit.t, outStop: exit.t + shortSec },
                b: { inStart: entry.t, inStop: entry.t + shortSec },
                rate: 1,
                exitBar: exit.bar, entryBar: entry.bar,
                beatPeriodA: A.period,
            };
        }
        let { bars: mixBars, sec: mixSec } = chooseBars(settings, A.bpm);
        // Длина входа в «секундах B» при подстройке темпа: B играет быстрее/медленнее в r раз
        const rate = settings.tempoSync ? tr.r : 1;
        // До дропа: если дроп рано — сокращаем сведение (8 → 4 → 2 такта), чтобы оно закончилось на нём
        let de = null;
        if (settings.toDrop) {
            for (let bars = mixBars; bars >= 2 && !de; bars /= 2) {
                const sec = bars * 4 * A.period;
                if (bars < mixBars && sec < 3) break;
                const d = dropEntry(B, durB, sec * rate, true, minTail);
                if (d) { de = d; mixBars = bars; mixSec = sec; }
            }
        }
        const xe = settings.toDrop ? dropEndExit(A, durA, mixSec, minStart) : null;
        const exit = xe || pickExit(A, durA, mixSec, yandexA, minStart);
        // Скорость каждого трека во время перехода: A·rateA = B·rateB (в долях)
        const rateA = split && stretch > 0.002 ? 1 / Math.sqrt(tr.r) : 1;
        const rateB = settings.tempoSync ? rate * rateA : 1;
        const meetBpm = (60 / A.period) * rateA;
        const entry = de ? { t: de.t, bar: null } : pickEntry(B, durB, mixSec * rate, settings.style);
        if (!exit || !entry) return fallbackPlan(durA, durB, settings, 'не нашлось тактов', yandexA, yandexB);
        return {
            kind: 'beatmatch',
            reason: `${A.bpm} → ${B.bpm} BPM, ${mixBars} тактов` + (rateA !== 1 ? `, встреча на ${meetBpm.toFixed(1)} BPM` : '') + (xe ? `, с конца дропа в ${fmtT(xe.end)}` : '') + (de ? `, до дропа в ${fmtT(de.drop.t)}` : ''),
            dropAligned: !!de, dropT: de ? de.drop.t : null,
            exitAligned: !!xe,
            mixSec,
            mixBars,
            a: { outStart: exit.t, outStop: exit.t + mixSec },
            // Движок требует одинаковую длину выхода и входа (в секундах на часах).
            b: { inStart: entry.t, inStop: entry.t + mixSec },
            rate,                         // отношение скоростей B/A (держит доли вместе)
            rateA, rateB,                 // скорость A и B во время перехода
            meetBpm: +meetBpm.toFixed(2),
            rampBars: settings.rampBars,
            tempoMultiple: tr.m,
            exitBar: exit.bar, entryBar: entry.bar,
            beatPeriodA: A.period,
            beatPeriodB: B.period,
        };
    }

    return { plan, tempoRatio, DEFAULTS };
})();


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

})();
