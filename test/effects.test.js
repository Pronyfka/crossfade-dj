// Тест эффектов на поддельном Web Audio: встраивание в граф плеера и автоматизация параметров.
// Запуск: node test/effects.test.js
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

// ---------- поддельный Web Audio ----------
class AudioParam {
    constructor(ctx, v) { this.ctx = ctx; this.def = v; this.ev = []; }
    get value() { return this.at(this.ctx.currentTime); }
    set value(v) { this.ev = []; this.def = v; }
    setValueAtTime(v, t) { this.ev.push({ k: 'set', v, t }); }
    linearRampToValueAtTime(v, t) { this.ev.push({ k: 'lin', v, t }); }
    exponentialRampToValueAtTime(v, t) { if (v <= 0) throw new Error('exp ≤ 0'); this.ev.push({ k: 'exp', v, t }); }
    setTargetAtTime(v, t, tc) { this.ev.push({ k: 'tgt', v, t, tc }); }
    cancelScheduledValues(t) { this.ev = this.ev.filter(e => e.t < t); }
    at(t) {
        const ev = this.ev.map((e, i) => Object.assign({ i }, e)).sort((a, b) => a.t - b.t || a.i - b.i);
        let v = this.def, pt = 0, tgt = null;
        for (const e of ev) {
            if (tgt && e.t > tgt.t) { v = tgt.v + (v - tgt.v) * Math.exp(-(Math.min(t, e.t) - tgt.t) / tgt.tc); tgt = null; }
            if (e.t > t) {
                if (e.k === 'lin') return v + (e.v - v) * (t - pt) / (e.t - pt);
                if (e.k === 'exp') return v * Math.pow(e.v / v, (t - pt) / (e.t - pt));
                break;
            }
            if (e.k === 'tgt') { tgt = e; pt = e.t; continue; }
            v = e.v; pt = e.t;
        }
        if (tgt) v = tgt.v + (v - tgt.v) * Math.exp(-(t - tgt.t) / tgt.tc);
        return v;
    }
}
class AudioNode {
    constructor(ctx, kind) { this.context = ctx; this.kind = kind; this.outs = new Set(); }
    connect(d) { this.outs.add(d); return d; }
    disconnect(d) { if (d) this.outs.delete(d); else this.outs.clear(); }
}
class AudioDestinationNode extends AudioNode {}
class BaseAudioContext {}
class AudioContext extends BaseAudioContext {
    constructor() { super(); this.currentTime = 0; this.sampleRate = 48000; this.destination = new AudioDestinationNode(this, 'dest'); }
    createGain() { const n = new AudioNode(this, 'gain'); n.gain = new AudioParam(this, 1); return n; }
    createBiquadFilter() { const n = new AudioNode(this, 'bq'); n.frequency = new AudioParam(this, 350); n.gain = new AudioParam(this, 0); n.Q = new AudioParam(this, 1); return n; }
    createChannelSplitter() { return new AudioNode(this, 'split'); }
    createChannelMerger() { return new AudioNode(this, 'merge'); }
    createDelay() { const n = new AudioNode(this, 'delay'); n.delayTime = new AudioParam(this, 0); return n; }
    createAnalyser() { return new AudioNode(this, 'an'); }
    createMediaElementSource(el) { const n = new AudioNode(this, 'src'); n.el = el; return n; }
}
Object.assign(global, { AudioContext, AudioNode, AudioDestinationNode, BaseAudioContext, window: global });

// Граф как у Яндекса (класс Mt): source → analyser → r128 → gain → destination
function yandexGraph(el, useGain) {
    const ctx = new AudioContext();
    const g = { audioElement: el, context: ctx, config: { useAnalyser: true, useGain } };
    g.sourceNode = ctx.createMediaElementSource(el);
    g.analyserNode = ctx.createAnalyser(); g.r128GainNode = ctx.createGain(); g.gainNode = ctx.createGain();
    g.sourceNode.connect(g.analyserNode); g.analyserNode.connect(g.r128GainNode);
    g.r128GainNode.connect(useGain ? g.gainNode : ctx.destination);
    if (useGain) g.gainNode.connect(ctx.destination);
    return g;
}
const reaches = (from, to, seen = new Set()) => { if (from === to) return true; if (seen.has(from)) return false; seen.add(from); for (const o of from.outs) if (reaches(o, to, seen)) return true; return false; };
const audio = (name) => ({ name, play() {}, currentTime: 0 });

const XFEffects = require('../src/effects.js');
const origConnect = AudioNode.prototype.connect;

// 1) Граф, созданный ДО установки, находится обходом
const elOld = audio('old');
const gOld = yandexGraph(elOld, true);
const fx = XFEffects.create({ log: () => {}, err: (w, e) => console.log('  err', w, e && e.message) });
check(fx.install(), 'установка');
const r1 = fx.discover([{ deep: { plugins: [{ graphs: new Set([gOld]) }] } }]);
const chOld = fx._chains.get(elOld);
check(r1.found === 1 && !!chOld, `старый граф найден обходом (${r1.found}, просмотрено ${r1.scanned})`);
check(chOld && gOld.gainNode.outs.has(chOld.input) && !gOld.gainNode.outs.has(gOld.context.destination), 'хвост плеера идёт в нашу цепочку, а не в динамики');
check(chOld && reaches(gOld.sourceNode, gOld.context.destination), 'звук по-прежнему доходит до динамиков');
check(fx.discover([{ graphs: new Set([gOld]) }]) && fx._chains.size === 1, 'повторный поиск не дублирует цепочку');

// 2) Граф, созданный ПОСЛЕ установки, подхватывается сам
const elNew = audio('new');
const gNew = yandexGraph(elNew, false);
const chNew = fx._chains.get(elNew);
check(!!chNew && gNew.r128GainNode.outs.has(chNew.input) && reaches(gNew.sourceNode, gNew.context.destination), 'новый граф подхвачен при подключении к динамикам');
check(chNew && !gNew.r128GainNode.outs.has(gNew.context.destination), 'у нового графа нет обхода мимо эффектов');

// 3) Бит в бит: обмен басов на середине
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const setTime = (t) => { gOld.context.currentTime = t; gNew.context.currentTime = t; };
const bm = { kind: 'beatmatch', mixSec: 15, mixBars: 8, beatPeriodA: 15 / 32, a: { outStart: 100 }, b: { inStart: 10 } };
setTime(50);
let res = fx.run(bm, { inEl: elNew, outEl: elOld, mode: 'auto', d0: 1 });
const ts = 50 + 1 + 4 * 15 / 32 * 4;   // середина: 4 такта после точки выхода
check(res.ok && res.name === 'обмен басов', `запуск: ${res.ok ? res.name : res.reason}`);
check(near(chNew.low.gain.at(50.2), XFEffects.LOW_KILL, 0.01), `у входящего срезаны низы в начале (${chNew.low.gain.at(50.2).toFixed(1)} дБ)`);
check(near(chOld.low.gain.at(ts - 0.6), 0, 0.01) && near(chNew.low.gain.at(ts - 0.6), XFEffects.LOW_KILL, 0.01), 'до середины басы у уходящего');
const midSwap = chOld.low.gain.at(ts);
check(midSwap < -8 && midSwap > -18, `обмен басов плавный, а не щелчком (на середине ${midSwap.toFixed(1)} дБ)`);
check(near(chOld.low.gain.at(ts + 0.6), XFEffects.LOW_KILL, 0.01) && near(chNew.low.gain.at(ts + 0.6), 0, 0.01), `после середины (${(ts - 50).toFixed(2)} с) басы у входящего`);
check(chOld.hp.frequency.at(ts + 4) > 50 && chOld.hp.frequency.at(ts - 1) < 11, `уходящий истончается во второй половине (${chOld.hp.frequency.at(ts + 4).toFixed(0)} Гц)`);
check(near(chOld.wet.gain.at(60), 0, 1e-9), 'в «бит в бит» эха нет');

// 4) Прерывание: всё возвращается в ноль
setTime(56);
check(fx.abort(), 'переход прерван');
check(near(chNew.low.gain.at(57), 0, 0.05) && near(chOld.hp.frequency.at(57), 10, 1) && near(chOld.low.gain.at(57), 0, 0.05), 'после прерывания фильтры нейтральны');

// 5) Плавный уход с эхом (темпы разные)
setTime(200);
const fd = { kind: 'fade', mixSec: 5.6, beatPeriodA: 60 / 90, a: { outStart: 150 }, b: { inStart: 0 } };
res = fx.run(fd, { inEl: elNew, outEl: elOld, mode: 'auto', d0: 1 });
check(res.ok && res.name === 'фильтр и эхо', `плавный уход: ${res.ok ? res.name : res.reason}`);
check(near(chOld.delay.delayTime.at(200.1), 60 / 90, 1e-6), `эхо в долю (${chOld.delay.delayTime.at(200.1).toFixed(3)} с)`);
const hpStart = chOld.hp.frequency.at(201.05), hpEnd = chOld.hp.frequency.at(206.5);
check(hpStart < 30 && hpEnd > 1000, `фильтр уходящего: ${hpStart.toFixed(0)} → ${hpEnd.toFixed(0)} Гц`);
check(chOld.wet.gain.at(206.5) > 0.5 && chOld.fb.gain.at(206.5) > 0.4, `эхо к концу (${chOld.wet.gain.at(206.5).toFixed(2)})`);
check(chNew.lp.frequency.at(201.05) < 2000 && chNew.lp.frequency.at(206) > 15000, 'входящий открывается фильтром');

// 6) Только EQ: без эха
fx.abort(0); setTime(300);
res = fx.run(fd, { inEl: elNew, outEl: elOld, mode: 'eq', d0: 1 });
check(res.ok && near(chOld.wet.gain.at(306.5), 0, 1e-6) && chOld.hp.frequency.at(306.5) > 300, 'режим «только EQ»: фильтр есть, эха нет');

// 7) Нет цепочки у элемента — честный отказ
res = fx.run(bm, { inEl: audio('x'), outEl: elOld, mode: 'auto', d0: 1 });
check(!res.ok && /нет доступа/.test(res.reason), `без доступа к звуку: «${res.reason}»`);

// 7б) Переход стартовал на 0.27 с позже точки выхода (как в отчёте) — обмен басов всё равно на такте
fx.abort(0); setTime(400);
res = fx.run(bm, { inEl: elNew, outEl: elOld, mode: 'auto', d0: -0.27 });
const ts2 = 400 - 0.27 + 4 * 15 / 32 * 4;
check(res.ok && near(chOld.low.gain.at(ts2 - 0.6), 0, 0.01) && near(chOld.low.gain.at(ts2 + 0.6), XFEffects.LOW_KILL, 0.01) && near(chNew.low.gain.at(ts2 + 0.6), 0, 0.01) && chOld.low.gain.at(ts2) < -8 && chOld.low.gain.at(ts2) > -18,
    `поздний старт: обмен басов на ${(ts2 - 400).toFixed(2)} с, а не позже`);
const hpMid = chOld.hp.frequency.at(ts2 + 3), hpEnd2 = chOld.hp.frequency.at(400 - 0.27 + 15);
check(hpEnd2 > 200 && hpMid > 10 && hpMid < hpEnd2, `поздний старт: фильтр доходит до конца вовремя (${hpEnd2.toFixed(0)} Гц)`);

// 7в) «Вокал поверх» в «бит в бит»
fx.abort(0); setTime(500);
res = fx.run(bm, { inEl: elNew, outEl: elOld, mode: 'vocal', d0: 0.5 });
const W = (ch, t) => [ch.wPos.gain.at(t), ch.wNeg.gain.at(t)];
check(res.ok && res.name === 'вокал поверх', `вокал поверх: ${res.ok ? res.name : res.reason}`);
const [wp, wn] = W(chOld, 500 + 0.5 + 10);
check(near(wp, 0, 1e-6) && near(wn, 0, 1e-6) && chOld.hp.frequency.at(510.5) > 240 && chOld.lp.frequency.at(510.5) < 6100 && near(chOld.low.gain.at(510.5), XFEffects.LOW_KILL, 0.01),
    'у уходящего остаётся центр 250–6000 Гц без низов (голос)');
check(chOld.level.gain.at(500.5 + 7.5) > 1.45, `голос уходящего подтянут по громкости (×${chOld.level.gain.at(508).toFixed(2)})`);
check(near(chNew.vox.gain.at(501), -8, 0.01) && near(chNew.vox.gain.at(500.5 + 15), 0, 0.01), 'у входящего сначала приглушена голосовая полоса, к концу — полный звук');
check(chOld.wet.gain.at(500.5 + 14.5) > 0.3, 'старый голос уходит в эхо');
const [wp0, wn0] = W(chOld, 500.01);
check(near(wp0, 1, 0.02) && near(wn0, -1, 0.02), 'в начале стерео не тронуто');
// Инструменты уходят постепенно: через 2 с после начала ещё слышна заметная часть баса
const lowAt2 = chOld.low.gain.at(500.5 + 2), lowAt1 = chOld.low.gain.at(500.5 + 1);
check(lowAt1 > -3 && lowAt2 > -12 && lowAt2 < lowAt1, `бас уходящего убирается плавно (через 1 с ${lowAt1.toFixed(1)} дБ, через 2 с ${lowAt2.toFixed(1)} дБ)`);
fx.abort(); setTime(520);
const [wp1, wn1] = W(chOld, 521);
check(near(wp1, 1, 0.01) && near(wn1, -1, 0.01) && near(chOld.level.gain.at(521), 1, 0.01) && near(chNew.vox.gain.at(521), 0, 0.01), 'после сброса стерео и громкость как были');

// 7г) Ползунки: свои значения применяются и ограничиваются
{
    const sharp = XFEffects.program(bm, { mode: 'auto', d0: 0, params: { swapBeats: 0, lowKill: -99, thin: 0 } });
    const lowSteps = sharp.out.filter(s => s.p === 'low');
    check(lowSteps.length === 1 && lowSteps[0].dur <= 0.061 && lowSteps[0].to === -36 && !sharp.out.some(s => s.p === 'hp'), 'ползунки: резкий обмен, срез ограничен -36 дБ, истончение выключено');
    const late = XFEffects.program(bm, { mode: 'auto', d0: 0, params: { swapAt: 0.75 } });
    check(Math.abs(late.swapAt - 6 * 4 * 15 / 32) < 1e-9, `ползунки: обмен басов на 75% (такт 6, ${late.swapAt.toFixed(2)} с)`);
    const noEcho = XFEffects.program(fd, { mode: 'auto', d0: 0, params: { echo: 0 } });
    check(!noEcho.out.some(s => s.p === 'wet') && noEcho.name === 'фильтр', 'ползунки: эхо 0 — эха нет');
    const vx = XFEffects.program(bm, { mode: 'vocal', d0: 0, params: { voxDip: -15, iso: 0.9 } });
    const isoEnd = Math.max(...vx.out.filter(s => s.p === 'low').map(s => s.at + s.dur));
    check(vx.in[0].to === -15 && Math.abs(isoEnd - 13.5) < 1e-6, `ползунки: вокал — приглушение -15 дБ, инструменты уходят за ${isoEnd.toFixed(1)} с`);
}

// 7д) «Профи» в «бит в бит»: новый трек заранее без баса и с прикрытым верхом, обмен басов на такте,
// потом старый истончается, его голос держится поверх, уходит в эхо
fx.abort(0); setTime(600);
{
    const proP = { lowKill: -30, swapAt: 0.5, swapBeats: 1, iso: 0.6, filter: 0.75, openIn: 0.6, voxLevel: 1.4, voxDip: -6, voxBack: 0.75, echo: 0.45, echoTail: 0.4, echoFrom: 0.8 };
    res = fx.run(bm, { inEl: elNew, outEl: elOld, mode: 'pro', params: proP, d0: 0.5 });
    const bar = 4 * 15 / 32, tsP = 600.5 + 4 * bar, beatP = 15 / 32;
    check(res.ok && res.name === 'профи: бит в бит', `профи: ${res.ok ? res.name : res.reason}`);
    check(near(chNew.low.gain.at(601), -30, 0.01) && chNew.lp.frequency.at(600.6) < 6000 && near(chNew.vox.gain.at(601), -6, 0.01), `профи: новый заходит без баса, верх прикрыт (${chNew.lp.frequency.at(600.6).toFixed(0)} Гц)`);
    check(chNew.lp.frequency.at(tsP - 0.05) > 15000, 'профи: к обмену верх нового открыт');
    check(near(chOld.low.gain.at(tsP - beatP), 0, 0.01) && near(chOld.low.gain.at(tsP + beatP), -30, 0.01) && near(chNew.low.gain.at(tsP + beatP), 0, 0.01), `профи: обмен басов на ${(tsP - 600).toFixed(2)} с за долю`);
    check(chOld.hp.frequency.at(tsP - 0.1) < 11 && chOld.hp.frequency.at(600.5 + 14) > 150 && chOld.wPos.gain.at(600.5 + 14) < 0.75, 'профи: старый истончается только после обмена');
    check(chOld.level.gain.at(tsP) > 1.35 && chNew.level.gain.at(600.6) > 1.5 && near(chNew.level.gain.at(tsP + 0.1), 1, 0.01), 'профи: голос старого поддержан, новый выведен заранее');
    check(near(chOld.wet.gain.at(tsP + 2), 0, 1e-6) && chOld.wet.gain.at(600.5 + 14.9) > 0.2, 'профи: эхо только в конце');
    const fdPro = fx.run(fd, { inEl: elNew, outEl: elOld, mode: 'pro', params: proP, d0: 0 });
    check(fdPro.ok && fdPro.name === 'профи: эхо-выход', `профи при разных темпах: ${fdPro.name}`);
}

// 7е) «До дропа»: бас нового ровно на дропе, у старого бас уходит за такт, эхо к дропу затихло
for (const mode of ['auto', 'pro', 'vocal']) {
    fx.abort(0); setTime(700);
    const bmD = Object.assign({}, bm, { dropAligned: true, dropT: 40 });
    res = fx.run(bmD, { inEl: elNew, outEl: elOld, mode, d0: 0.5 });
    const drop = 700.5 + 15, barD = 4 * 15 / 32;
    const okIn = near(chNew.low.gain.at(drop - 0.06), XFEffects.LOW_KILL, 0.01) && near(chNew.low.gain.at(drop + 0.01), 0, 0.01);
    const okOut = near(chOld.low.gain.at(drop - 0.1), XFEffects.LOW_KILL, 0.01) && (mode === 'vocal' || chOld.low.gain.at(drop - barD - 0.05) > -1);
    const wetAtDrop = chOld.wet.gain.at(drop), wetBefore = chOld.wet.gain.at(drop - barD);
    const okEcho = wetAtDrop < 0.01 && (mode === 'vocal' || mode === 'pro' || mode === 'auto' ? wetBefore > 0.2 : true);
    const okVox = mode === 'auto' || (near(chNew.vox.gain.at(drop - 0.2), -8, 0.01) && near(chNew.vox.gain.at(drop + 0.01), 0, 0.01));
    check(res.ok && res.name.startsWith('до дропа') && okIn && okOut && okEcho && okVox,
        `до дропа [${mode}]: ${res.name}; бас нового до/на дропе ${chNew.low.gain.at(drop - 0.06).toFixed(0)}/${chNew.low.gain.at(drop + 0.01).toFixed(0)} дБ, эхо за такт ${wetBefore.toFixed(2)} → на дропе ${wetAtDrop.toFixed(3)}`);
}

// 7ж) Старый уходит с конца своего дропа: бас до последней доли, громкость поддержана, на дропе нового — только новый
for (const mode of ['auto', 'pro']) {
    fx.abort(0); setTime(800);
    const bmX = Object.assign({}, bm, { dropAligned: true, dropT: 40, exitAligned: true });
    res = fx.run(bmX, { inEl: elNew, outEl: elOld, mode, d0: 0.5 });
    const drop = 800.5 + 15, beatX = 15 / 32;
    const lowLate = chOld.low.gain.at(drop - beatX - 0.05), lowEnd = chOld.low.gain.at(drop - 0.01);
    const lvl = chOld.level.gain.at(800.5 + 12);
    check(res.ok && lowLate > -1 && near(lowEnd, XFEffects.LOW_KILL, 0.01) && lvl > 1.35 && near(chNew.low.gain.at(drop + 0.01), 0, 0.01),
        `конец дропа старого [${mode}]: бас старого за долю до конца ${lowLate.toFixed(1)} дБ, на конце ${lowEnd.toFixed(0)} дБ; громкость старого ×${lvl.toFixed(2)}`);
}

// 8) Снятие: граф плеера как был
fx.uninstall();
check(AudioNode.prototype.connect === origConnect, 'connect восстановлен');
check(gOld.gainNode.outs.has(gOld.context.destination) && !gOld.gainNode.outs.has(chOld.input), 'старый граф снова напрямую в динамики');
check(gNew.r128GainNode.outs.has(gNew.context.destination), 'новый граф снова напрямую в динамики');

// 9) Программа: все экспоненциальные значения > 0, шаги по времени
for (const p of [bm, fd, { kind: 'smooth', mixSec: 6 }]) for (const mode of ['auto', 'eq', 'vocal', 'pro']) {
    const pr = XFEffects.program(p, { mode, d0: 0.8 });
    const bad = [...pr.out, ...pr.in].filter(s => s.exp && (s.to <= 0 || (s.from !== undefined && s.from <= 0)));
    check(!bad.length && pr.end > p.mixSec, `программа ${p.kind}/${mode}: ${pr.name}, конец через ${pr.end.toFixed(1)} с`);
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе тесты пройдены');
process.exitCode = failed ? 1 : 0;
