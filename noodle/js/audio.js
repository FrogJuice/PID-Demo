/* Noodle — Web Audio synth, drum kit and metronome click. */
(function (root) {
  'use strict';

  // ---------- presets ----------
  // osc: oscillators summed before the filter. ratio = frequency multiple.
  // fm:  {ratio, index, indexEnd, decay} carrier-at-pitch FM pair.
  // amp: ADSR (seconds, sustain level 0-1). filter: lowpass with an envelope.
  const PRESETS = {
    pluck: {
      label: 'Pluck', oct: 4, gm: 25, gain: 0.5, verb: 0.22,
      osc: [{ type: 'sawtooth', detune: -7, gain: 0.5 }, { type: 'square', detune: 7, gain: 0.25 }],
      filter: { freq: 500, peak: 6000, decay: 0.2, q: 3, track: 0.6 },
      amp: { a: 0.002, d: 0.55, s: 0, r: 0.12 },
    },
    keys: {
      label: 'Keys', oct: 4, gm: 4, gain: 0.55, verb: 0.25,
      fm: { ratio: 1, index: 2.2, indexEnd: 0.25, decay: 1.2 },
      osc: [{ type: 'sine', ratio: 2, gain: 0.08 }],
      amp: { a: 0.003, d: 2.6, s: 0.12, r: 0.35 },
    },
    pad: {
      label: 'Pad', oct: 4, gm: 89, gain: 0.32, verb: 0.5,
      osc: [{ type: 'sawtooth', detune: -12, gain: 0.4 }, { type: 'sawtooth', detune: 12, gain: 0.4 }, { type: 'triangle', ratio: 0.5, gain: 0.35 }],
      filter: { freq: 1400, peak: 2200, decay: 1.5, q: 0.7, track: 0.3 },
      amp: { a: 0.35, d: 1.2, s: 0.85, r: 1.4 },
    },
    fuzz: {
      label: 'Fuzz', oct: 4, gm: 30, gain: 0.22, verb: 0.16,
      osc: [{ type: 'sawtooth', detune: -9, gain: 0.5 }, { type: 'sawtooth', detune: 9, gain: 0.5 }, { type: 'square', ratio: 0.5, gain: 0.3 }],
      drive: 9,
      filter: { freq: 2800, peak: 4200, decay: 0.3, q: 1.2, track: 0.2 },
      amp: { a: 0.004, d: 0.3, s: 0.85, r: 0.18 },
    },
    bass: {
      label: 'Bass', oct: 2, gm: 38, gain: 0.6, verb: 0.05,
      osc: [{ type: 'square', gain: 0.35 }, { type: 'sine', ratio: 0.5, gain: 0.7 }],
      filter: { freq: 350, peak: 2600, decay: 0.14, q: 5, track: 0.3 },
      amp: { a: 0.003, d: 0.45, s: 0.55, r: 0.09 },
    },
    bell: {
      label: 'Bell', oct: 5, gm: 14, gain: 0.4, verb: 0.42,
      fm: { ratio: 3.5, index: 4, indexEnd: 0.1, decay: 1.6 },
      amp: { a: 0.001, d: 3.2, s: 0, r: 1.6 },
    },
    drums: { label: 'Drums', drums: true, gain: 0.9, verb: 0.08 },
  };
  const PRESET_ORDER = ['pluck', 'keys', 'pad', 'fuzz', 'bass', 'bell', 'drums'];

  // 12 pads, General MIDI drum notes. Layout rows top -> bottom.
  const DRUMS = [
    { note: 49, name: 'Crash' }, { note: 51, name: 'Ride' }, { note: 56, name: 'Cowbell' },
    { note: 50, name: 'Hi tom' }, { note: 47, name: 'Mid tom' }, { note: 45, name: 'Low tom' },
    { note: 42, name: 'Hat' }, { note: 46, name: 'Open hat' }, { note: 39, name: 'Clap' },
    { note: 36, name: 'Kick' }, { note: 38, name: 'Snare' }, { note: 37, name: 'Rim' },
  ];

  let ctx = null, master, voiceBus, verbSend, clickBus, noiseBuf, comp;
  const live = new Map(); // key -> voice, for held notes
  let openHat = null;

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // MIDI velocity -> amplitude. About 26 dB between velocity 20 and 127,
  // which is roughly what a real piano or drum spans.
  function velAmp(vel) { const v = Math.max(1, Math.min(127, vel)) / 127; return 0.13 + 0.87 * Math.pow(v, 1.5); }

  function ensure() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    comp = ctx.createDynamicsCompressor();
    // Gentle safety limiter only: heavier settings flatten velocity.
    comp.threshold.value = -4; comp.knee.value = 6; comp.ratio.value = 3;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = 0.9;
    comp.connect(master).connect(ctx.destination);

    voiceBus = ctx.createGain();
    voiceBus.connect(comp);
    const verb = ctx.createConvolver();
    verb.buffer = impulse(2.4, 2.8);
    verbSend = ctx.createGain(); verbSend.gain.value = 1;
    verbSend.connect(verb); verb.connect(comp);

    clickBus = ctx.createGain(); clickBus.gain.value = 0.6;
    clickBus.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function impulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  // iOS: start the context from a gesture, play one silent buffer, and ask
  // for "playback" audio so the ring/silent switch does not mute the synth.
  function unlock() {
    ensure();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    if (ctx.state !== 'running') ctx.resume();
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination); s.start(0);
  }

  function holdAt(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
  }

  let driveCurve = null;
  function curve(k) {
    if (driveCurve && driveCurve.k === k) return driveCurve.c;
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    driveCurve = { k, c };
    return c;
  }

  // ---------- melodic voice ----------
  function synthVoice(P, midi, vel, t) {
    const f = mtof(midi);
    const v = vel / 127;
    const out = ctx.createGain();
    out.gain.value = 0;
    const mix = ctx.createGain();
    const srcs = [];
    for (const o of P.osc || []) {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.value = f * (o.ratio || 1);
      osc.detune.value = o.detune || 0;
      const g = ctx.createGain(); g.gain.value = o.gain;
      osc.connect(g).connect(mix);
      srcs.push(osc);
    }
    if (P.fm) {
      const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
      car.frequency.value = f; mod.frequency.value = f * P.fm.ratio;
      const depth = f * P.fm.ratio;
      mg.gain.setValueAtTime(depth * P.fm.index * (0.4 + 0.6 * v), t);
      mg.gain.setTargetAtTime(depth * P.fm.indexEnd, t, P.fm.decay / 3);
      mod.connect(mg).connect(car.frequency);
      const cg = ctx.createGain(); cg.gain.value = 0.8;
      car.connect(cg).connect(mix);
      srcs.push(car, mod);
    }
    let node = mix;
    if (P.drive) {
      const pre = ctx.createGain(); pre.gain.value = 1.5;
      const ws = ctx.createWaveShaper(); ws.curve = curve(P.drive); ws.oversample = '2x';
      node.connect(pre).connect(ws); node = ws;
    }
    if (P.filter) {
      const F = P.filter;
      const kt = Math.pow(f / 261.6, F.track || 0);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = F.q;
      const base = Math.min(18000, F.freq * kt);
      const peak = Math.min(18000, Math.max(base, F.peak * kt * (0.35 + 0.65 * v)));
      lp.frequency.setValueAtTime(peak, t);
      lp.frequency.setTargetAtTime(base, t, F.decay / 3);
      node.connect(lp); node = lp;
    }
    node.connect(out);
    out.connect(voiceBus);
    const send = ctx.createGain(); send.gain.value = P.verb;
    out.connect(send).connect(verbSend);

    const A = P.amp, peakAmp = P.gain * velAmp(vel);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peakAmp, t + A.a);
    out.gain.setTargetAtTime(peakAmp * A.s, t + A.a, A.d / 3);
    srcs.forEach(s => s.start(t));
    // Let un-released voices die on their own when sustain is zero.
    const natural = A.s === 0 ? t + A.a + A.d * 2.5 : null;
    if (natural) srcs.forEach(s => s.stop(natural + 0.1));
    let stopped = false;
    return {
      release(tr) {
        if (stopped) return; stopped = true;
        tr = Math.max(tr, ctx.currentTime);
        holdAt(out.gain, tr);
        out.gain.setTargetAtTime(0, tr, A.r / 4);
        const end = tr + A.r * 1.5 + 0.05;
        if (!natural || end < natural) srcs.forEach(s => { try { s.stop(end); } catch (e) { /* already stopping */ } });
      },
    };
  }

  // ---------- drums ----------
  function noise(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur);
    return s;
  }
  function envGain(t, peak, decay, attack) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + (attack || 0.001));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (attack || 0.001) + decay);
    return g;
  }
  function metal(t, dur, dest, level) {
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    const g = ctx.createGain(); g.gain.value = level == null ? 1 : level; g.connect(dest);
    for (const r of ratios) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 40 * r * 1.7;
      o.connect(g); o.start(t); o.stop(t + dur);
    }
  }
  // Reverb send per drum: kick and rim dry, snare and clap get a dash.
  const SEND = { 36: 0.01, 37: 0.03, 38: 0.09, 39: 0.1 };

  function drumHit(note, vel, t) {
    const v = vel / 127;
    const out = ctx.createGain(); out.gain.value = PRESETS.drums.gain * velAmp(vel);
    out.connect(voiceBus);
    const send = ctx.createGain(); send.gain.value = SEND[note] != null ? SEND[note] : PRESETS.drums.verb; out.connect(send).connect(verbSend);
    const bp = (f, q) => { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; return b; };
    const hp = f => { const b = ctx.createBiquadFilter(); b.type = 'highpass'; b.frequency.value = f; return b; };

    switch (note) {
      case 36: { // kick: pitch-dropping body + sub tail + soft-clipped punch + beater
        const sat = ctx.createWaveShaper(); sat.curve = curve(2.2); sat.connect(out);
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.09);
        o.frequency.exponentialRampToValueAtTime(44, t + 0.45);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1.05, t + 0.002);
        g.gain.setTargetAtTime(0.63, t + 0.01, 0.06); g.gain.setTargetAtTime(0, t + 0.12, 0.13);
        o.connect(g).connect(sat); o.start(t); o.stop(t + 0.8);
        const sub = ctx.createOscillator(); sub.frequency.value = 46;
        const sg = ctx.createGain(); sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(0.38, t + 0.02); sg.gain.setTargetAtTime(0, t + 0.08, 0.12);
        sub.connect(sg).connect(out); sub.start(t); sub.stop(t + 0.8);
        const c = noise(t, 0.02); const cg = envGain(t, 0.3, 0.01); c.connect(bp(3500, 0.8)).connect(cg).connect(out);
        break;
      }
      case 38: { // snare: stick crack + fast-dropping shells (soft-clipped) + wires
        const sat = ctx.createWaveShaper(); sat.curve = curve(1.8); sat.connect(out);
        const crack = noise(t, 0.012); const cg = envGain(t, 0.9, 0.008); crack.connect(bp(3200, 1.2)).connect(cg).connect(out);
        for (const [f0, f1, a] of [[290, 185, 0.95], [420, 300, 0.35]]) {
          const o = ctx.createOscillator(); o.type = 'triangle';
          o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.025);
          const og = envGain(t, a, 0.1); o.connect(og).connect(sat); o.start(t); o.stop(t + 0.2);
        }
        const n = noise(t, 0.25);
        const g = envGain(t, 0.8, 0.15), ga = envGain(t, 0.25, 0.08);
        n.connect(bp(1900, 0.7)).connect(g).connect(out); n.connect(hp(5000)).connect(ga).connect(out);
        break;
      }
      case 37: { // rim
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1700;
        const g = envGain(t, 0.4, 0.025); o.connect(bp(1700, 4)).connect(g).connect(out); o.start(t); o.stop(t + 0.06);
        break;
      }
      case 39: { // clap: three fast bursts, then a tail
        const f = bp(1100, 1.2); f.connect(out);
        for (let i = 0; i < 3; i++) {
          const n = noise(t + i * 0.011, 0.02); const g = envGain(t + i * 0.011, 0.8, 0.01); n.connect(g).connect(f);
        }
        const n = noise(t + 0.033, 0.3); const g = envGain(t + 0.033, 0.7, 0.18); n.connect(g).connect(f);
        break;
      }
      case 42: case 46: { // hats; closed chokes open
        if (openHat) { try { holdAt(openHat.gain, t); openHat.gain.setTargetAtTime(0, t, 0.012); } catch (e) { /* gone */ } openHat = null; }
        const open = note === 46, dur = open ? 1.4 : 0.07;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(open ? 0.3 : 0.34, t + 0.001);
        if (open) { g.gain.setTargetAtTime(0.17, t + 0.002, 0.05); g.gain.setTargetAtTime(0, t + 0.12, 0.32); }
        else g.gain.setTargetAtTime(0, t + 0.002, 0.02);
        const f = hp(open ? 6200 : 7200); f.connect(g).connect(out);
        metal(t, dur, f, 0.55);
        const n = noise(t, dur); const ng = ctx.createGain(); ng.gain.value = open ? 0.45 : 0.25; n.connect(ng).connect(f);
        if (open) openHat = g;
        break;
      }
      case 49: { // crash
        const g = envGain(t, 0.32, 1.6);
        const f = hp(4500); f.connect(g).connect(out);
        metal(t, 1.6, f, 1);
        const n = noise(t, 1.6); const ng = ctx.createGain(); ng.gain.value = 0.6; n.connect(ng).connect(f);
        break;
      }
      case 51: { // ride: long metallic wash (inharmonic square cluster + air) with a small stick ping
        const wash = ctx.createGain();
        wash.gain.setValueAtTime(0, t); wash.gain.linearRampToValueAtTime(0.2, t + 0.003);
        wash.gain.setTargetAtTime(0.11, t + 0.004, 0.08); wash.gain.setTargetAtTime(0, t + 0.15, 0.9);
        const band = bp(7800, 0.6), top = hp(5200), soft = ctx.createBiquadFilter();
        soft.type = 'lowpass'; soft.frequency.value = 13000;
        band.connect(top).connect(soft).connect(wash).connect(out);
        const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
        for (const r of ratios) {
          const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 310 * r * (1 + (Math.random() - 0.5) * 0.01);
          const og = ctx.createGain(); og.gain.value = 0.16; o.connect(og).connect(band); o.start(t); o.stop(t + 3.5);
        }
        const n = noise(t, 3); const ng = ctx.createGain(); ng.gain.value = 0.35; n.connect(hp(8500)).connect(ng).connect(wash);
        const ping = ctx.createOscillator(); ping.frequency.value = 5100;
        const pg = envGain(t, 0.035, 0.18); ping.connect(pg).connect(out); ping.start(t); ping.stop(t + 0.3);
        const tick = noise(t, 0.01); const tg = envGain(t, 0.14, 0.006); tick.connect(bp(6500, 1)).connect(tg).connect(out);
        break;
      }
      case 45: case 47: case 50: { // toms
        const base = { 45: 95, 47: 135, 50: 185 }[note];
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(base * 1.6, t); o.frequency.exponentialRampToValueAtTime(base, t + 0.08);
        const g = envGain(t, 0.9, 0.38); o.connect(g).connect(out); o.start(t); o.stop(t + 0.45);
        const n = noise(t, 0.05); const ng = envGain(t, 0.15, 0.04); n.connect(bp(base * 4, 1)).connect(ng).connect(out);
        break;
      }
      case 56: { // cowbell
        const f = bp(800, 3); const g = envGain(t, 0.5, 0.35); f.connect(g).connect(out);
        for (const fr of [540, 800]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fr; o.connect(f); o.start(t); o.stop(t + 0.4); }
        break;
      }
      default: break;
    }
  }

  // ---------- public ----------
  // key: any id for a held note (so it can be released later). time: ctx time.
  function noteOn(presetKey, midi, vel, time, key) {
    ensure();
    const P = PRESETS[presetKey];
    const t = Math.max(time == null ? ctx.currentTime : time, ctx.currentTime);
    if (P.drums) { drumHit(midi, vel, t); return null; }
    const v = synthVoice(P, midi, vel, t);
    if (key != null) {
      const prev = live.get(key);
      if (prev) prev.release(t);
      live.set(key, v);
    }
    return v;
  }
  function noteOff(key, time) {
    const v = live.get(key);
    if (!v) return;
    live.delete(key);
    v.release(time == null ? ctx.currentTime : time);
  }
  function allOff() {
    for (const v of live.values()) v.release(ctx.currentTime);
    live.clear();
  }
  // Schedule a complete note (playback).
  function playNote(presetKey, midi, vel, t, dur) {
    const v = noteOn(presetKey, midi, vel, t, null);
    if (v) v.release(t + dur);
  }

  function click(t, level) { // level: 2 = downbeat, 1 = group accent, 0 = beat
    ensure();
    const o = ctx.createOscillator();
    o.frequency.value = level === 2 ? 2000 : level === 1 ? 1500 : 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level ? 1 : 0.6, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g).connect(clickBus);
    o.start(t); o.stop(t + 0.05);
  }
  function setClickVolume(x) { ensure(); clickBus.gain.value = x; }

  // Context time at which the listener HEARD the moment of a UI event, using
  // the output timestamp so device output latency cancels out.
  function heardTime(eventTimeStamp) {
    ensure();
    const now = performance.now();
    let ts = eventTimeStamp;
    if (!(ts > 0) || Math.abs(ts - now) > 2000) ts = now;
    try {
      const o = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
      if (o && o.contextTime > 0 && o.performanceTime > 0 && Math.abs(o.performanceTime - now) < 1000) {
        return o.contextTime + (ts - o.performanceTime) / 1000;
      }
    } catch (e) { /* fall through */ }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - (now - ts) / 1000;
  }

  root.NoodleAudio = {
    PRESETS, PRESET_ORDER, DRUMS,
    ensure, unlock, noteOn, noteOff, allOff, playNote, click, setClickVolume, heardTime,
    get ctx() { return ensure(); },
    get started() { return !!ctx; },
  };
})(window);
