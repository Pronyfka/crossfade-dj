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
if (typeof module !== 'undefined') module.exports = XFPlanner;
