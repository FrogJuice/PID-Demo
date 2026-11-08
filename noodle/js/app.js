/* Noodle — app: state, tracks, transport, keyboard, roll, editor, sheets, library. */
(function () {
  'use strict';
  const T = window.NoodleTheory, A = window.NoodleAudio, M = window.NoodleMidi;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const round = x => Math.round(x * 10000) / 10000;
  const clamp = T.clamp;

  // Drum rows top -> bottom (roll and editor): cymbals up top, kick at the bottom.
  const DRUM_ROWS = [49, 51, 46, 42, 56, 50, 47, 45, 39, 37, 38, 36];
  const drumName = n => (A.DRUMS.find(d => d.note === n) || { name: '?' }).name;

  // ---------------- settings (per-device convenience) ----------------
  const DEFAULTS = {
    bpm: 92, num: 4, den: 4, bars: 4, countIn: 1, metro: true, clickVol: 0.6,
    loop: false, recMode: 'layer', latencyMs: 0, vel: 'fixed', layout: 'piano', rotate: 'rec',
    preset: 'pluck', oct: {}, q: { grid: 'off', swing: 0.5, strength: 1, ends: false },
    key: null, keyColors: true, projectId: null, takeId: null,
  };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('noodle.settings') || '{}') }; } catch (e) { /* storage blocked */ }
  if (!['piano', 'pads', 'scale'].includes(settings.layout)) settings.layout = 'piano';
  if (!['fixed', 'y', 'touch'].includes(settings.vel)) settings.vel = 'fixed';
  function saveSettings() { try { localStorage.setItem('noodle.settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ } }

  // ---------------- data ----------------
  // take = {id, kind:'take', projectId, name, created, updated, bpm, num, den, bars,
  //         key: {tonic, mode} | null, cur, tracks: [{id, preset, notes, q, mute}]}
  let store = null;
  const projects = new Map();
  const takes = new Map();
  let take = null;
  const undoStack = [];

  function newTrack(preset) {
    return { id: 'k' + uid(), preset, notes: [], q: { ...settings.q }, mute: false };
  }
  function newTake(projectId, preset) {
    const n = [...takes.values()].filter(t => t.projectId === projectId).length + 1;
    return {
      id: 't' + uid(), kind: 'take', projectId, name: 'Take ' + n,
      created: Date.now(), updated: Date.now(),
      bpm: settings.bpm, num: settings.num, den: settings.den, bars: settings.bars,
      key: settings.key ? { ...settings.key } : null,
      cur: 0, tracks: [newTrack(preset || settings.preset)],
    };
  }
  // Older takes had one sound: notes/preset/q on the take itself.
  function migrate(t) {
    if (!Array.isArray(t.tracks)) {
      t.tracks = [{ id: 'k' + uid(), preset: t.preset || 'pluck', notes: t.notes || [], q: t.q || { ...DEFAULTS.q }, mute: false }];
      delete t.notes; delete t.preset; delete t.q;
    }
    for (const tr of t.tracks) {
      if (!A.PRESETS[tr.preset]) tr.preset = 'pluck';
      tr.notes = Array.isArray(tr.notes) ? tr.notes : [];
      tr.q = tr.q || { ...DEFAULTS.q };
    }
    if (!(t.cur >= 0 && t.cur < t.tracks.length)) t.cur = 0;
    if (t.key === undefined) t.key = null;
    return t;
  }
  function newProject(name) {
    return { id: 'p' + uid(), kind: 'project', name, created: Date.now(), updated: Date.now() };
  }

  const trk = () => take.tracks[take.cur];
  const noteCount = t => t.tracks.reduce((s, tr) => s + tr.notes.length, 0);
  const presetDrums = k => !!A.PRESETS[k].drums;
  const isDrums = () => presetDrums(trk().preset);
  const barQ = (t = take) => T.barQuarters(t.num, t.den);
  const loopLen = (t = take) => t.bars * barQ(t);
  const spq = () => T.secPerQuarter(take.bpm, take.den);
  const qNotes = (tr, t = take) => T.quantizeNotes(tr.notes, tr.q, t.num, t.den, loopLen(t));
  function songEvents(t = take) {
    const ev = [];
    for (const tr of t.tracks) {
      if (tr.mute) continue;
      for (const n of qNotes(tr, t)) ev.push({ ...n, preset: tr.preset });
    }
    return ev.sort((a, b) => a.t - b.t);
  }
  function melodicNotes(t) {
    const out = [];
    for (const tr of t.tracks) if (!presetDrums(tr.preset)) out.push(...qNotes(tr, t));
    return out;
  }
  const trackLabel = (tr, i) => `${i + 1} · ${A.PRESETS[tr.preset].label}`;

  const saveTimers = new Map();
  function persistTake(t, now) {
    t = t || take;
    if (!noteCount(t) && !takes.has(t.id)) return; // never store empty, unsaved takes
    t.updated = Date.now();
    takes.set(t.id, t);
    clearTimeout(saveTimers.get(t.id));
    const write = () => {
      saveTimers.delete(t.id);
      if (store) store.put(t).catch(err => toast('Could not save: ' + (err && err.message || err)));
    };
    if (now) write(); else saveTimers.set(t.id, setTimeout(write, 500));
  }
  function persistProject(p) {
    p.updated = Date.now();
    projects.set(p.id, p);
    if (store) store.put(p).catch(err => toast('Could not save: ' + (err && err.message || err)));
  }

  function pushUndo() {
    undoStack.push({ takeId: take.id, tracks: JSON.stringify(take.tracks), cur: take.cur });
    if (undoStack.length > 80) undoStack.shift();
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return false;
    if (u.takeId !== take.id) { undoStack.length = 0; return false; }
    take.tracks = JSON.parse(u.tracks);
    take.cur = Math.min(u.cur, take.tracks.length - 1);
    persistTake();
    return true;
  }

  // ---------------- toast ----------------
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // =================================================================
  // Transport
  // =================================================================
  const TR = {
    state: 'idle', mode: null, // state: idle | count | rec | play
    t0: 0, clickPos: 0, playList: [], playIdx: 0, playIter: 0,
    timer: null, raf: null, held: new Map(), prevTake: null, loop: false, captured: 0,
  };

  function startTransport(mode) {
    A.unlock();
    const ctx = A.ctx;
    TR.mode = mode; TR.loop = settings.loop; TR.captured = 0; TR.held.clear();
    if (mode === 'rec') {
      if (settings.recMode === 'new' && noteCount(take)) {
        TR.prevTake = take;
        take = newTake(settings.projectId, trk().preset);
        undoStack.length = 0;
      } else {
        pushUndo();
        if (settings.recMode === 'replace') trk().notes = [];
      }
      document.body.classList.add('recording');
    } else {
      document.body.classList.add('playing');
    }
    const countIn = mode === 'rec' && settings.countIn ? barQ() : 0;
    TR.t0 = ctx.currentTime + 0.15 + countIn * spq();
    TR.clickPos = -countIn;
    TR.playIter = 0; TR.playIdx = 0;
    TR.playList = songEvents();
    TR.state = countIn ? 'count' : mode;
    applyRotation();
    renderHeader();
    sizeRoll();
    wakeLock(true);
    TR.timer = setInterval(tick, 25);
    tick();
    TR.raf = requestAnimationFrame(frame);
  }

  function stopTransport() {
    if (TR.state === 'idle') return;
    clearInterval(TR.timer);
    cancelAnimationFrame(TR.raf);
    for (const key of [...TR.held.keys()]) captureOff(key, null, A.ctx.currentTime);
    const wasRec = TR.mode === 'rec';
    TR.state = 'idle';
    A.allOff();
    document.body.classList.remove('recording', 'playing');
    $('#countdown').hidden = true;
    wakeLock(false);
    if (wasRec) {
      if (TR.captured) {
        persistTake(take, true);
        settings.takeId = take.id; saveSettings();
        const label = A.PRESETS[trk().preset].label;
        toast(TR.prevTake ? 'Saved ' + take.name : settings.recMode === 'replace' ? 'Replaced ' + label : 'Layered onto ' + label);
      } else if (TR.prevTake) {
        take = TR.prevTake; // nothing played: keep the previous take loaded
      } else {
        undo(); // nothing played: put back what was there
      }
      TR.prevTake = null;
    }
    applyRotation();
    renderAll();
  }

  function clickLevel(pos) {
    const bq = barQ();
    const inBar = ((pos % bq) + bq) % bq;
    if (inBar < 1e-6) return 2;
    const beatQ = T.quartersPerBeat(take.den);
    const beatIdx = Math.round(inBar / beatQ);
    if (take.den === 8 && take.num % 3 === 0 && take.num > 3 && beatIdx % 3 === 0) return 1;
    return 0;
  }

  function tick() {
    const ctx = A.ctx;
    const now = ctx.currentTime, horizon = now + 0.12;
    const s = spq(), L = loopLen(), beatQ = T.quartersPerBeat(take.den);

    // metronome (count-in always clicks)
    while (TR.t0 + TR.clickPos * s < horizon) {
      if (!TR.loop && TR.clickPos >= L - 1e-6) break;
      const at = TR.t0 + TR.clickPos * s;
      if ((settings.metro || TR.clickPos < 0) && at >= now - 0.005) A.click(at, clickLevel(TR.clickPos));
      TR.clickPos += beatQ;
    }

    // every unmuted track, sorted by start time
    let guard = 0;
    while (guard++ < 4000) {
      if (TR.playIdx >= TR.playList.length) {
        if (!TR.loop) break;
        const nextStart = TR.t0 + (TR.playIter + 1) * L * s;
        if (nextStart >= horizon) break;
        TR.playIter++; TR.playIdx = 0;
        TR.playList = songEvents(); // picks up the pass just recorded
        if (!TR.playList.length) break;
        continue;
      }
      const n = TR.playList[TR.playIdx];
      const at = TR.t0 + (TR.playIter * L + n.t) * s;
      if (at >= horizon) break;
      if (at >= now - 0.01) A.playNote(n.preset, n.p, n.v, at, n.d * s);
      TR.playIdx++;
    }

    if (TR.state === 'count' && now >= TR.t0) TR.state = 'rec';
    if (!TR.loop && now >= TR.t0 + L * s) stopTransport();
  }

  function frame() {
    if (TR.state === 'idle') return;
    const s = spq(), L = loopLen(), bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    const heard = A.heardTime(performance.now());
    const q = (heard - TR.t0) / s;
    const cd = $('#countdown');
    let pos = null;
    if (q < 0) {
      cd.hidden = false;
      cd.textContent = String(Math.ceil(-q / beatQ));
    } else {
      cd.hidden = true;
      pos = TR.loop ? q % L : Math.min(q, L);
      const bar = Math.floor(pos / bq) + 1;
      const beat = Math.floor((pos % bq) / beatQ) + 1;
      $('#counter').textContent = bar + '.' + beat + (TR.loop && TR.mode === 'rec' ? ' ×' + (Math.floor(q / L) + 1) : '');
    }
    if (ED.open) drawEditor(pos); else drawRoll(pos);
    TR.raf = requestAnimationFrame(frame);
  }

  let lock = null;
  async function wakeLock(on) {
    try {
      if (on && navigator.wakeLock && !lock) lock = await navigator.wakeLock.request('screen');
      if (!on && lock) { lock.release(); lock = null; }
    } catch (e) { lock = null; }
  }

  // ---------------- capture ----------------
  const beatAt = ctxTime => (ctxTime - TR.t0) / spq();
  const heardNow = evTs => A.heardTime(evTs) - settings.latencyMs / 1000;

  function captureOn(key, p, v, evTs) {
    if (TR.mode !== 'rec' || TR.state === 'idle') return;
    let b = beatAt(heardNow(evTs));
    if (b < -0.3) return; // noodling during the count-in
    if (b < 0) b = 0;
    if (!TR.loop && b >= loopLen()) return;
    TR.held.set(key, { p, v, start: b });
    if (isDrums()) captureOff(key, evTs);
  }
  function captureOff(key, evTs, ctxTime) {
    const h = TR.held.get(key);
    if (!h) return;
    TR.held.delete(key);
    const end = beatAt(ctxTime != null ? ctxTime : heardNow(evTs));
    const L = loopLen();
    const t = TR.loop ? h.start % L : h.start;
    let d = isDrums() ? 0.25 : Math.max(0.05, end - h.start);
    d = Math.min(d, L - t);
    if (d <= 0) return;
    trk().notes.push({ p: h.p, t: round(t), d: round(d), v: Math.round(h.v) });
    TR.captured++;
  }

  // ---------------- landscape keys while recording ----------------
  function applyRotation() {
    const W = window.innerWidth, H = window.innerHeight;
    document.documentElement.style.setProperty('--W', W + 'px');
    document.documentElement.style.setProperty('--H', H + 'px');
    const rot = TR.state !== 'idle' && TR.mode === 'rec' && settings.rotate === 'rec' &&
      !isDrums() && settings.layout === 'piano' && H > W;
    document.body.classList.toggle('rot', rot);
  }

  // =================================================================
  // Key colors
  // =================================================================
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, f) => a.map((x, i) => Math.round(x + (b[i] - x) * f));
  const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const C = { rest: hexRgb('#34c3a5'), mid: hexRgb('#f2b134'), tense: hexRgb('#ff4d6d'),
    ivory: hexRgb('#efe9de'), ebony: hexRgb('#2b2731'), pad: hexRgb('#2a2631') };
  function tensionColor(x) { return x < 0.5 ? mix(C.rest, C.mid, x / 0.5) : mix(C.mid, C.tense, (x - 0.5) / 0.5); }
  function tint(el, midi, base) {
    const k = take.key;
    if (!settings.keyColors || !k || isDrums()) return;
    const c = tensionColor(T.tension(midi % 12, k.tonic, k.mode));
    const [f, fd] = base === C.ebony ? [0.6, 0.9] : base === C.ivory ? [0.5, 0.8] : [0.62, 0.95];
    el.style.setProperty('--kbg', rgb(mix(base, c, f)));
    el.style.setProperty('--kdown', rgb(mix(base, c, fd)));
    if (base === C.pad) el.classList.add('tinted');
  }

  // =================================================================
  // Keyboard
  // =================================================================
  const kb = $('#keyboard');
  let kbModel = null; // piano: {whites, blacks:[{el, c}]}; grid: {cols, rows, cells}

  function octave() {
    const d = A.PRESETS[trk().preset].oct || 4;
    return settings.oct[trk().preset] != null ? settings.oct[trk().preset] : d;
  }

  function cell(cls, note, label) {
    const b = document.createElement('div');
    b.className = cls; b.dataset.note = note;
    b.innerHTML = label;
    return b;
  }

  function buildKeyboard() {
    kb.innerHTML = '';
    document.body.classList.toggle('drums', isDrums());
    const octLabel = 'C' + octave();
    $('#oct-label').textContent = octLabel;
    $('#rec-oct-label').textContent = settings.layout === 'scale' && take.key ? T.NOTE_NAMES[take.key.tonic] + octave() : octLabel;
    if (isDrums()) {
      const g = document.createElement('div');
      g.className = 'pads kit';
      const cells = A.DRUMS.map(d => cell('pad', d.note, d.name));
      cells.forEach(c => g.appendChild(c));
      kb.appendChild(g);
      kbModel = { kind: 'grid', cols: 3, rows: 4, cells };
      return;
    }
    if (settings.layout === 'scale') {
      const k = take.key || { tonic: 0, mode: 'major' };
      const base = 12 * (octave() + 1) + k.tonic;
      const notes = T.scaleNotes(base, k.mode, 16);
      const len = T.MODES[k.mode].pcs.length;
      const cols = 4, rows = 4, cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = (rows - 1 - r) * cols + c; // lowest notes on the bottom row
          const deg = i % len;
          const n = notes[i];
          const el = cell('pad' + (deg === 0 ? ' root' : ''), n, `${T.NOTE_NAMES[n % 12]}${deg === 0 ? Math.floor(n / 12) - 1 : ''}<span class="deg">${deg + 1}</span>`);
          tint(el, n, C.pad);
          cells.push(el);
        }
      }
      const g = document.createElement('div');
      g.className = 'pads scale4';
      cells.forEach(c => g.appendChild(c));
      kb.appendChild(g);
      kbModel = { kind: 'grid', cols, rows, cells };
      return;
    }
    const base = 12 * (octave() + 1);
    if (settings.layout === 'pads') {
      const order = [8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]; // bottom row = C..D#
      const cells = order.map(i => {
        const black = [1, 3, 6, 8, 10].includes(i);
        const el = cell('pad' + (black ? ' dark' : '') + (i === 0 ? ' root' : ''), base + i, T.NOTE_NAMES[i] + (i === 0 ? octave() : ''));
        tint(el, base + i, C.pad);
        return el;
      });
      const g = document.createElement('div');
      g.className = 'pads melodic';
      cells.forEach(c => g.appendChild(c));
      kb.appendChild(g);
      kbModel = { kind: 'grid', cols: 4, rows: 3, cells };
      return;
    }
    const piano = document.createElement('div');
    piano.className = 'piano';
    const whites = [0, 2, 4, 5, 7, 9, 11, 12].map(semi => {
      const k = cell('wkey' + (semi % 12 === 0 ? ' root' : ''), base + semi, semi % 12 === 0 ? 'C' + (octave() + semi / 12) : T.NOTE_NAMES[semi]);
      tint(k, base + semi, C.ivory);
      piano.appendChild(k);
      return k;
    });
    const blacks = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]].map(([semi, wi]) => { // wi: white key to its right
      const k = cell('bkey', base + semi, '');
      k.style.left = `calc(${(wi / 8) * 100}% - ${(0.62 / 8 / 2) * 100}% - 1.5px)`;
      k.style.width = `${(0.62 / 8) * 100}%`;
      tint(k, base + semi, C.ebony);
      piano.appendChild(k);
      return { el: k, c: wi };
    });
    kb.appendChild(piano);
    kbModel = { kind: 'piano', whites, blacks };
  }

  // Keyboard-local coordinates, honoring the sideways recording layout.
  function localPoint(cx, cy) {
    const r = kb.getBoundingClientRect();
    const w = kb.offsetWidth, h = kb.offsetHeight;
    if (document.body.classList.contains('rot')) return { x: cy - r.top, y: r.right - cx, w, h };
    return { x: cx - r.left, y: cy - r.top, w, h };
  }
  // Geometric hit test: every point on the keyboard belongs to some key, so
  // fast taps that land in the gap between keys still play.
  function hitAt(cx, cy) {
    if (!kbModel) return null;
    const p = localPoint(cx, cy);
    if (p.x < -4 || p.y < -4 || p.x > p.w + 4 || p.y > p.h + 4) return null;
    const x = clamp(p.x, 0, p.w - 0.01), y = clamp(p.y, 0, p.h - 0.01);
    if (kbModel.kind === 'piano') {
      const ww = p.w / 8, bh = p.h * 0.58;
      if (y < bh) for (const b of kbModel.blacks) if (Math.abs(x - b.c * ww) <= ww * 0.31 + 2) return { el: b.el, fy: y / bh };
      return { el: kbModel.whites[Math.floor(x / ww)], fy: y / p.h };
    }
    const cw = p.w / kbModel.cols, ch = p.h / kbModel.rows;
    const c = Math.floor(x / cw), r = Math.floor(y / ch);
    return { el: kbModel.cells[r * kbModel.cols + c], fy: (y - r * ch) / ch };
  }

  // ---------------- velocity ----------------
  // Position: lower on the key = louder. Touch: 3D Touch force where the phone
  // reports it, otherwise contact size, calibrated from your recent taps.
  const sense = { force: [], size: [], used: '' };
  function spreadOf(arr, x) {
    arr.push(x); if (arr.length > 40) arr.shift();
    if (arr.length < 6) return null;
    const s = [...arr].sort((a, b) => a - b);
    const lo = s[Math.floor(s.length * 0.1)], hi = s[Math.floor(s.length * 0.9)];
    return hi - lo > 1e-3 ? clamp((x - lo) / (hi - lo), 0, 1) : null;
  }
  const posVel = hit => 20 + 107 * clamp((hit.fy - 0.08) / 0.84, 0, 1);
  function velocityFor(hit, src) {
    if (settings.vel === 'fixed') { sense.used = ''; return isDrums() ? 110 : 100; }
    if (settings.vel === 'touch' && src) {
      const f = src.force || (src.pointerType === 'touch' ? src.pressure : 0) || 0;
      const r = src.radiusX || (src.pointerType === 'touch' ? (src.width || 0) / 2 : 0);
      if (f > 0) { const k = spreadOf(sense.force, f); if (k != null) { sense.used = 'force'; return 25 + 102 * k; } }
      if (r > 0) { const k = spreadOf(sense.size, r); if (k != null) { sense.used = 'touch size'; return 25 + 102 * k; } }
      sense.used = 'position (no touch data yet)';
      return posVel(hit);
    }
    sense.used = 'position';
    return posVel(hit);
  }
  let velShowTimer;
  function showVel(v) {
    if (settings.vel === 'fixed' || TR.state !== 'idle') return;
    $('#counter').textContent = `vel ${v}`;
    if (settings.vel === 'touch') VEL_HINTS.last = `Last tap: velocity ${v}, read from ${sense.used}.`;
    clearTimeout(velShowTimer);
    velShowTimer = setTimeout(() => { if (TR.state === 'idle') renderCounter(); }, 1600);
  }

  // ---------------- touch / pointer input ----------------
  const active = new Map(); // id -> {el, note}
  function press(id, hit, src, ts) {
    const note = +hit.el.dataset.note;
    const v = Math.round(velocityFor(hit, src));
    A.noteOn(trk().preset, note, v, null, 'k' + id);
    hit.el.classList.add('down');
    active.set(id, { el: hit.el, note });
    captureOn('k' + id, note, v, ts);
    showVel(v);
  }
  function release(id, ts) {
    const a = active.get(id);
    if (!a) return;
    active.delete(id);
    a.el.classList.remove('down');
    A.noteOff('k' + id);
    captureOff('k' + id, ts);
  }
  function down(id, cx, cy, src, ts) {
    if (!A.started || A.ctx.state !== 'running') A.unlock();
    const h = hitAt(cx, cy);
    if (h && h.el) press(id, h, src, ts);
  }
  function moveTo(id, cx, cy, src, ts) {
    const a = active.get(id);
    if (!a || isDrums()) return;
    const h = hitAt(cx, cy);
    if (h && h.el && h.el !== a.el) { release(id, ts); press(id, h, src, ts); }
  }
  // Touch events directly: one handler per finger, no gesture recognition.
  kb.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) down('t' + t.identifier, t.clientX, t.clientY, t, e.timeStamp);
  }, { passive: false });
  kb.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) moveTo('t' + t.identifier, t.clientX, t.clientY, t, e.timeStamp);
  }, { passive: false });
  const touchEnd = e => {
    e.preventDefault();
    for (const t of e.changedTouches) release('t' + t.identifier, e.timeStamp);
  };
  kb.addEventListener('touchend', touchEnd, { passive: false });
  kb.addEventListener('touchcancel', touchEnd, { passive: false });
  // Mouse and pen.
  kb.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    try { kb.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    down('p' + e.pointerId, e.clientX, e.clientY, e, e.timeStamp);
  });
  kb.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') moveTo('p' + e.pointerId, e.clientX, e.clientY, e, e.timeStamp); });
  ['pointerup', 'pointercancel'].forEach(t => kb.addEventListener(t, e => { if (e.pointerType !== 'touch') release('p' + e.pointerId, e.timeStamp); }));
  kb.addEventListener('contextmenu', e => e.preventDefault());

  // Computer keyboard: A W S E D F T G Y H U J K (and on for pads).
  const KEYMAP = 'awsedftgyhujkolp';
  document.addEventListener('keydown', e => {
    if (e.repeat || e.metaKey || e.ctrlKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (ED.open) { edKey(e); return; }
    if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); return; }
    if (e.key === 'r') { $('#btn-rec').click(); return; }
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i < 0 || !kbModel) return;
    let el = null;
    if (kbModel.kind === 'piano') el = kb.querySelector(`[data-note="${12 * (octave() + 1) + i}"]`);
    else if (isDrums() || settings.layout === 'scale') {
      const sorted = [...kbModel.cells].sort((a, b) => +a.dataset.note - +b.dataset.note);
      el = isDrums() ? kbModel.cells[i] : sorted[i];
    } else el = kb.querySelector(`[data-note="${12 * (octave() + 1) + i}"]`);
    if (!el) return;
    A.unlock();
    press('key' + e.key, { el, fy: 0.8 }, null, e.timeStamp);
  });
  document.addEventListener('keyup', e => { if (KEYMAP.includes(e.key.toLowerCase())) release('key' + e.key, e.timeStamp); });

  function setOct(o) {
    settings.oct[trk().preset] = Math.max(0, Math.min(7, o));
    saveSettings(); buildKeyboard();
  }
  $('#oct-down').onclick = () => setOct(octave() - 1);
  $('#oct-up').onclick = () => setOct(octave() + 1);
  $('#rec-oct-down').onclick = () => setOct(octave() - 1);
  $('#rec-oct-up').onclick = () => setOct(octave() + 1);

  // =================================================================
  // Piano roll (overview)
  // =================================================================
  const canvas = $('#roll');
  const cx = canvas.getContext('2d');
  let rollW = 0, rollH = 0;
  function sizeRoll() {
    requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      rollW = canvas.offsetWidth; rollH = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.round(rollW * dpr));
      canvas.height = Math.max(1, Math.round(rollH * dpr));
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRoll(null);
    });
  }
  window.addEventListener('resize', () => { applyRotation(); sizeRoll(); if (ED.open) edSize(false); });

  const cssCache = {};
  const css = name => cssCache[name] || (cssCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim());

  function drawRoll(playhead) {
    if (!rollW) return;
    const W = rollW, H = rollH, L = loopLen(), bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    const x = q => (q / L) * W;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = css('--panel'); cx.fillRect(0, 0, W, H);
    for (let b = 1; b < take.bars; b += 2) {
      cx.fillStyle = css('--panel-2'); cx.globalAlpha = 0.45; cx.fillRect(x(b * bq), 0, x(bq), H); cx.globalAlpha = 1;
    }
    const q = trk().q, g = T.GRIDS[q.grid];
    if (g && g.cell && x(g.cell) > 4) {
      cx.strokeStyle = css('--line'); cx.globalAlpha = 0.35; cx.lineWidth = 1;
      const pair = g.swing ? g.cell * 2 : g.cell;
      const pts = g.swing ? [0, pair * q.swing] : [0];
      for (let b = 0; b < take.bars; b++) {
        for (let qq = 0; qq < bq - 1e-6; qq += pair) {
          for (const off of pts) { const xx = Math.round(x(b * bq + qq + off)) + 0.5; cx.beginPath(); cx.moveTo(xx, 0); cx.lineTo(xx, H); cx.stroke(); }
        }
      }
      cx.globalAlpha = 1;
    }
    for (let qq = 0; qq <= L + 1e-6; qq += beatQ) {
      const isBar = Math.abs(qq / bq - Math.round(qq / bq)) < 1e-6;
      cx.strokeStyle = isBar ? css('--muted') : css('--line');
      cx.globalAlpha = isBar ? 0.6 : 0.8;
      const xx = Math.round(x(qq)) + 0.5;
      cx.beginPath(); cx.moveTo(xx, 0); cx.lineTo(xx, H); cx.stroke();
    }
    cx.globalAlpha = 1;
    $('#roll-empty').hidden = noteCount(take) > 0 || TR.state !== 'idle';

    const curDrums = isDrums();
    const same = take.tracks.filter(tr => presetDrums(tr.preset) === curDrums);
    const other = take.tracks.filter(tr => presetDrums(tr.preset) !== curDrums && tr.notes.length);
    let rows, rowOf;
    if (curDrums) {
      rows = DRUM_ROWS.length; rowOf = p => DRUM_ROWS.length - 1 - Math.max(0, DRUM_ROWS.indexOf(p));
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const tr of same) for (const n of tr.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
      if (!isFinite(lo)) { lo = 60; hi = 72; }
      if (hi - lo < 11) { const pad = (11 - (hi - lo)) / 2; lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad); }
      rows = hi - lo + 1; rowOf = p => p - lo;
    }
    const strip = other.length ? Math.min(12, H * 0.1) : 0;
    const rh = (H - 8 - strip) / rows;
    const y = r => H - 4 - (r + 1) * rh;
    // tracks of the other kind (drums under a melody or vice versa): a strip on top
    cx.fillStyle = css('--muted');
    for (const tr of other) {
      cx.globalAlpha = tr.mute ? 0.15 : 0.5;
      for (const n of qNotes(tr)) cx.fillRect(x(n.t), 3, Math.max(2, x(n.d) - 1), strip - 4);
    }
    // other tracks of the same kind: dim
    for (const tr of same) {
      if (tr === trk()) continue;
      cx.globalAlpha = tr.mute ? 0.15 : 0.45;
      for (const n of qNotes(tr)) roundRect(cx, x(n.t), y(rowOf(n.p)), Math.max(3, x(n.d) - 1), Math.max(2, rh - 1), 2);
    }
    cx.globalAlpha = 1;
    const cur = trk();
    const qOn = cur.q.grid !== 'off' && cur.q.strength > 0;
    if (qOn) { // ghost of what was actually played
      cx.strokeStyle = css('--muted'); cx.globalAlpha = 0.5; cx.lineWidth = 1;
      for (const n of cur.notes) if (!n.lock) cx.strokeRect(x(n.t) + 0.5, y(rowOf(n.p)) + 0.5, Math.max(2, x(n.d) - 1), Math.max(2, rh - 1));
      cx.globalAlpha = 1;
    }
    cx.fillStyle = css('--amber');
    for (const n of qNotes(cur)) {
      const hh = Math.max(2, rh - 1);
      cx.globalAlpha = (cur.mute ? 0.3 : 1) * (0.45 + 0.55 * (n.v / 127));
      roundRect(cx, x(n.t), y(rowOf(n.p)), Math.max(3, x(n.d) - 1), hh, Math.min(3, hh / 2));
    }
    cx.globalAlpha = 1;
    if (playhead != null) {
      cx.fillStyle = TR.mode === 'rec' ? css('--rec') : css('--fg');
      cx.fillRect(Math.round(x(playhead)) - 1, 0, 2, H);
    }
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
    c.fill();
  }
  canvas.addEventListener('click', () => { if (TR.state === 'idle') openEditor(); });

  // =================================================================
  // Header / chips / transport buttons
  // =================================================================
  function keyLabel(k) { return k ? `${T.NOTE_NAMES[k.tonic]} ${T.MODES[k.mode].short}` : 'Key'; }
  function renderCounter() {
    const n = noteCount(take);
    $('#counter').textContent = n ? `${n} ${n === 1 ? 'note' : 'notes'}` : '';
  }
  function renderHeader() {
    $('#take-name').textContent = take.name;
    const p = projects.get(take.projectId) || projects.get(settings.projectId);
    $('#project-name').textContent = p ? p.name : '';
    $('#sound-label').textContent = A.PRESETS[trk().preset].label + (take.tracks.length > 1 ? ` ${take.cur + 1}/${take.tracks.length}` : '');
    $('#chip-bpm').innerHTML = `${take.bpm} <small>BPM</small>`;
    $('#chip-meter').textContent = `${take.num}/${take.den}`;
    $('#chip-bars').innerHTML = `${take.bars} <small>${take.bars === 1 ? 'bar' : 'bars'}</small>`;
    $('#chip-key').textContent = keyLabel(take.key);
    $('#chip-key').classList.toggle('mono', !!take.key);
    $('#chip-metro').setAttribute('aria-pressed', String(settings.metro));
    $('#chip-loop').setAttribute('aria-pressed', String(settings.loop));
    const q = trk().q, qOn = q.grid !== 'off' && q.strength > 0;
    $('#q-label').textContent = qOn ? q.grid + (T.GRIDS[q.grid].swing && q.swing > 0.505 ? ' sw' : '') : 'Q off';
    $('#btn-q').classList.toggle('on', qOn);
    if (TR.state === 'idle') renderCounter();
    $('#btn-rec .tlabel').textContent = TR.state === 'idle' ? 'Rec' : 'Stop';
  }
  function renderAll() {
    renderHeader();
    buildKeyboard();
    sizeRoll();
    if (ED.open) edSize(false);
  }

  $('#btn-rec').onclick = () => { if (TR.state === 'idle') startTransport('rec'); else stopTransport(); };
  $('#btn-play').onclick = () => { if (TR.state === 'idle') startTransport('play'); else stopTransport(); };
  $('#chip-metro').onclick = () => { settings.metro = !settings.metro; saveSettings(); renderHeader(); };
  $('#chip-loop').onclick = () => {
    settings.loop = !settings.loop; saveSettings(); renderHeader();
    toast(settings.loop ? 'Loop on: recording layers every pass' : 'Loop off');
  };
  $('#btn-new').onclick = () => {
    if (TR.state !== 'idle') return;
    if (!noteCount(take)) { toast('Already on a fresh take'); return; }
    take = newTake(settings.projectId, trk().preset); undoStack.length = 0; renderAll(); toast('New take');
  };

  // =================================================================
  // Sheets
  // =================================================================
  let openSheetEl = null;
  function openSheet(id) {
    if (TR.state !== 'idle') return;
    closeSheet();
    openSheetEl = $(id);
    openSheetEl.hidden = false;
    $('#scrim').hidden = false;
    refreshSheet(id);
  }
  function closeSheet() {
    if (!openSheetEl) return;
    if (openSheetEl.id === 'sheet-take') commitRename();
    openSheetEl.hidden = true;
    $('#scrim').hidden = true;
    openSheetEl = null;
    disarm();
  }
  $('#scrim').onclick = closeSheet;
  $$('[data-close]').forEach(b => b.onclick = closeSheet);

  function segSet(sel, val) { $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(val))); }
  function segOn(sel, fn) { $$(sel + ' button').forEach(b => b.onclick = () => { fn(b.dataset.v); segSet(sel, b.dataset.v); }); }

  const VEL_HINTS = {
    fixed: 'Every note plays at the same velocity.',
    y: 'Lower on the key or pad = louder. Most reliable on any phone.',
    touch: 'Uses how hard (3D Touch phones) or how much finger area you press. Many phones report neither, so it falls back to position. Play a few notes, then reopen this menu to see what your phone reports.',
    last: '',
  };

  function refreshSheet(id) {
    if (id === '#sheet-sound') {
      renderTracks();
      $$('#preset-grid .preset').forEach(b => b.classList.toggle('on', b.dataset.v === trk().preset));
      segSet('#seg-layout', settings.layout);
      segSet('#seg-vel', settings.vel);
      $('#vel-hint').textContent = VEL_HINTS[settings.vel] + (settings.vel === 'touch' && VEL_HINTS.last ? ' ' + VEL_HINTS.last : '');
    }
    if (id === '#sheet-key') {
      $$('#tonic-grid button').forEach(b => b.classList.toggle('on', !!take.key && +b.dataset.v === take.key.tonic));
      $$('#mode-grid button').forEach(b => b.classList.toggle('on', !!take.key && b.dataset.v === take.key.mode));
      segSet('#seg-colors', settings.keyColors ? 1 : 0);
    }
    if (id === '#sheet-setup') {
      $('#bpm-val').textContent = take.bpm;
      $('#bpm-range').value = take.bpm;
      $('#meter-val').textContent = `${take.num}/${take.den}`;
      segSet('#seg-den', take.den);
      segSet('#seg-bars', take.bars);
      segSet('#seg-countin', settings.countIn);
      segSet('#seg-recmode', settings.recMode);
      segSet('#seg-rotate', settings.rotate);
      $('#click-vol').value = settings.clickVol;
      $('#latency').value = settings.latencyMs;
      $('#latency-val').textContent = settings.latencyMs + ' ms';
    }
    if (id === '#sheet-q') {
      const q = trk().q;
      $$('#grid-pick button').forEach(b => b.classList.toggle('on', b.dataset.v === q.grid));
      const sw = T.GRIDS[q.grid] && T.GRIDS[q.grid].swing;
      $('#row-swing').style.opacity = sw ? 1 : 0.35;
      $('#swing').disabled = !sw;
      $('#swing').value = Math.round(q.swing * 100);
      $('#swing-val').textContent = Math.round(q.swing * 100) + '%';
      $('#strength').value = Math.round(q.strength * 100);
      $('#strength-val').textContent = Math.round(q.strength * 100) + '%';
      segSet('#seg-ends', q.ends ? 1 : 0);
      $('#sheet-q h2').textContent = 'Quantize · ' + A.PRESETS[trk().preset].label;
    }
    if (id === '#sheet-take') {
      $('#take-rename').value = take.name;
      const sel = $('#take-project');
      sel.innerHTML = '';
      for (const p of sortedProjects()) sel.add(new Option(p.name, p.id, false, p.id === take.projectId));
      const est = T.estimateKey(T.analyze(melodicNotes(take), take.num, take.den));
      $('#take-key').innerHTML = est
        ? `Sounds like <b>${est.label}</b>${est.confident ? '' : ' (low confidence)'} · ${Math.round(est.match.fit * 100)}% of notes in that scale`
        : noteCount(take) ? 'Drums only.' : 'No notes yet.';
      $('#act-undo').disabled = !undoStack.length;
      $('#act-export').disabled = !noteCount(take);
    }
  }

  // --- tracks + sound sheet
  $('#btn-sound').onclick = () => openSheet('#sheet-sound');
  function selectTrack(i) {
    take.cur = i; settings.preset = trk().preset; saveSettings();
    persistTake(); renderAll();
    if (openSheetEl && openSheetEl.id === 'sheet-sound') refreshSheet('#sheet-sound');
  }
  function renderTracks() {
    const list = $('#track-list');
    list.innerHTML = '';
    take.tracks.forEach((tr, i) => {
      const row = document.createElement('div');
      row.className = 'trow' + (i === take.cur ? ' on' : '');
      row.innerHTML = `<button class="tsel"></button><button class="tmute" aria-label="Mute">M</button><button class="tdel" aria-label="Delete track">×</button>`;
      const n = tr.notes.length;
      row.querySelector('.tsel').innerHTML = `<span></span><small>${n} ${n === 1 ? 'note' : 'notes'}</small>`;
      row.querySelector('.tsel span').textContent = trackLabel(tr, i);
      row.querySelector('.tsel').onclick = () => selectTrack(i);
      const mute = row.querySelector('.tmute');
      mute.setAttribute('aria-pressed', String(!!tr.mute));
      mute.onclick = () => { tr.mute = !tr.mute; persistTake(); renderTracks(); drawRoll(null); };
      row.querySelector('.tdel').onclick = e => {
        if (take.tracks.length === 1) { toast('A take needs one track'); return; }
        const doIt = () => {
          pushUndo();
          take.tracks.splice(i, 1);
          take.cur = Math.min(take.cur >= i && take.cur > 0 ? take.cur - 1 : take.cur, take.tracks.length - 1);
          persistTake(); renderAll(); renderTracks(); toast('Track deleted (undo in Take menu)');
        };
        if (!tr.notes.length) doIt(); else twoStep(e.currentTarget, '?', doIt);
      };
      list.appendChild(row);
    });
  }
  $('#btn-add-track').onclick = () => {
    const hasDrums = take.tracks.some(tr => presetDrums(tr.preset));
    const preset = isDrums() ? 'pluck' : hasDrums ? 'keys' : 'drums';
    take.tracks.push(newTrack(preset));
    selectTrack(take.tracks.length - 1);
    toast(`Added track ${take.tracks.length}: pick its sound below`);
  };
  const pg = $('#preset-grid');
  for (const k of A.PRESET_ORDER) {
    const b = document.createElement('button');
    b.className = 'preset'; b.dataset.v = k; b.textContent = A.PRESETS[k].label;
    b.onclick = () => {
      A.unlock();
      settings.preset = k; saveSettings();
      if (trk().notes.length && presetDrums(k) !== isDrums()) {
        // Drum notes and melody notes mean different things: give it its own track.
        take.tracks.push(newTrack(k));
        take.cur = take.tracks.length - 1;
        toast(`Added a ${A.PRESETS[k].label} track`);
      } else {
        trk().preset = k;
      }
      persistTake();
      refreshSheet('#sheet-sound');
      renderAll();
      if (isDrums()) A.playNote(k, 38, 100, A.ctx.currentTime + 0.01, 0.2);
      else A.playNote(k, 12 * (octave() + 1) + 7, 100, A.ctx.currentTime + 0.01, 0.4);
    };
    pg.appendChild(b);
  }
  segOn('#seg-layout', v => {
    settings.layout = v; saveSettings(); buildKeyboard();
    if (v === 'scale' && !take.key) toast('No key set: scale pads use C major. Tap Key to choose.');
  });
  segOn('#seg-vel', v => { settings.vel = v; saveSettings(); $('#vel-hint').textContent = VEL_HINTS[v]; });

  // --- key sheet
  $('#chip-key').onclick = () => openSheet('#sheet-key');
  (function () {
    const tg = $('#tonic-grid');
    T.NOTE_NAMES.forEach((n, i) => {
      const b = document.createElement('button'); b.dataset.v = i; b.textContent = n;
      b.onclick = () => setKey({ tonic: i, mode: take.key ? take.key.mode : 'major' });
      tg.appendChild(b);
    });
    const mg = $('#mode-grid');
    T.MODE_ORDER.forEach(m => {
      const b = document.createElement('button'); b.dataset.v = m; b.textContent = T.MODES[m].label;
      b.onclick = () => setKey({ tonic: take.key ? take.key.tonic : 0, mode: m });
      mg.appendChild(b);
    });
  })();
  function setKey(k) {
    take.key = k; settings.key = k ? { ...k } : null; saveSettings();
    persistTake(); renderHeader(); buildKeyboard(); refreshSheet('#sheet-key');
  }
  $('#key-off').onclick = () => setKey(null);
  $('#key-detect').onclick = () => {
    const est = T.estimateKey(T.analyze(melodicNotes(take), take.num, take.den));
    if (!est) { toast('Record some notes first'); return; }
    setKey({ tonic: est.tonic, mode: est.mode });
    toast('Sounds like ' + est.label + (est.confident ? '' : ' (low confidence)'));
  };
  segOn('#seg-colors', v => { settings.keyColors = v === '1'; saveSettings(); buildKeyboard(); });

  // --- setup sheet
  ['#chip-bpm', '#chip-meter', '#chip-bars'].forEach(s => $(s).onclick = () => openSheet('#sheet-setup'));
  function setTempo(b) {
    take.bpm = Math.max(40, Math.min(240, Math.round(b)));
    settings.bpm = take.bpm; saveSettings(); persistTake();
    refreshSheet('#sheet-setup'); renderHeader();
  }
  $('#bpm-down').onclick = () => setTempo(take.bpm - 1);
  $('#bpm-up').onclick = () => setTempo(take.bpm + 1);
  $('#bpm-range').oninput = e => setTempo(+e.target.value);
  let taps = [];
  $('#btn-tap').onpointerdown = e => {
    e.preventDefault();
    A.unlock();
    A.click(A.ctx.currentTime, 1);
    const t = performance.now();
    taps = taps.filter(x => t - x < 2500);
    taps.push(t);
    if (taps.length >= 3) setTempo(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  };
  function setMeter(num, den) {
    take.num = Math.max(1, Math.min(15, num)); take.den = den;
    settings.num = take.num; settings.den = den; saveSettings(); persistTake();
    refreshSheet('#sheet-setup'); renderHeader(); sizeRoll();
  }
  $('#num-down').onclick = () => setMeter(take.num - 1, take.den);
  $('#num-up').onclick = () => setMeter(take.num + 1, take.den);
  segOn('#seg-den', v => setMeter(take.num, +v));
  segOn('#seg-bars', v => { take.bars = +v; settings.bars = +v; saveSettings(); persistTake(); renderHeader(); sizeRoll(); });
  segOn('#seg-countin', v => { settings.countIn = +v; saveSettings(); });
  segOn('#seg-recmode', v => { settings.recMode = v; saveSettings(); });
  segOn('#seg-rotate', v => { settings.rotate = v; saveSettings(); });
  $('#click-vol').oninput = e => { settings.clickVol = +e.target.value; A.setClickVolume(settings.clickVol); saveSettings(); };
  $('#latency').oninput = e => { settings.latencyMs = +e.target.value; $('#latency-val').textContent = settings.latencyMs + ' ms'; saveSettings(); };

  // --- quantize sheet (per track)
  $('#btn-q').onclick = () => openSheet('#sheet-q');
  const gp = $('#grid-pick');
  for (const k of T.GRID_ORDER) {
    const b = document.createElement('button');
    b.dataset.v = k; b.textContent = T.GRIDS[k].label;
    b.onclick = () => { trk().q.grid = k; qChanged(); };
    gp.appendChild(b);
  }
  $('#swing').oninput = e => { trk().q.swing = +e.target.value / 100; qChanged(); };
  $('#strength').oninput = e => { trk().q.strength = +e.target.value / 100; qChanged(); };
  segOn('#seg-ends', v => { trk().q.ends = v === '1'; qChanged(); });
  function qChanged() {
    settings.q = { ...trk().q }; saveSettings(); persistTake();
    refreshSheet('#sheet-q'); renderHeader(); drawRoll(null);
  }

  // --- take sheet
  $('#btn-title').onclick = () => openSheet('#sheet-take');
  function commitRename() {
    const v = $('#take-rename').value.trim();
    if (v && v !== take.name) { take.name = v; persistTake(); renderHeader(); }
  }
  $('#take-rename').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); commitRename(); } });
  $('#take-project').onchange = e => {
    take.projectId = e.target.value; settings.projectId = take.projectId; saveSettings();
    persistTake(); renderHeader();
    toast('Moved to ' + projects.get(take.projectId).name);
  };
  $('#act-edit').onclick = () => openEditor();
  $('#act-export').onclick = () => exportTakes([take], take.name);
  $('#act-undo').onclick = () => {
    if (!undo()) { toast('Nothing to undo'); return; }
    refreshSheet('#sheet-take'); renderAll(); toast('Undone');
  };
  $('#act-dup').onclick = () => {
    const copy = JSON.parse(JSON.stringify(take));
    copy.id = 't' + uid(); copy.name = take.name + ' copy'; copy.created = Date.now();
    take = copy; undoStack.length = 0; persistTake(take, true); closeSheet(); renderAll(); toast('Duplicated');
  };
  $('#act-new').onclick = () => { take = newTake(settings.projectId, trk().preset); undoStack.length = 0; closeSheet(); renderAll(); };
  // Two-step confirm (dialogs are not available everywhere this runs).
  let armed = null;
  function disarm() { if (armed) { armed.classList.remove('armed'); armed.textContent = armed.dataset.label; armed = null; } }
  function twoStep(btn, label, fn) {
    if (armed === btn) { disarm(); fn(); return; }
    disarm();
    armed = btn; btn.dataset.label = btn.textContent;
    btn.classList.add('armed'); btn.textContent = label;
    setTimeout(() => { if (armed === btn) disarm(); }, 4000);
  }
  $('#act-delete').onclick = e => twoStep(e.currentTarget, 'Tap again to delete', async () => {
    const gone = take;
    takes.delete(gone.id);
    if (store) await store.remove(gone.id).catch(() => {});
    const next = [...takes.values()].filter(t => t.projectId === gone.projectId).sort((a, b) => b.updated - a.updated)[0];
    take = next || newTake(settings.projectId);
    undoStack.length = 0;
    closeSheet(); renderAll(); toast('Deleted ' + gone.name);
  });

  // =================================================================
  // Note editor
  // =================================================================
  const ED = { open: false, pxq: 80, sx: 0, sy: 0, sel: -1, W: 0, H: 0, ptrs: new Map(), g: null, lastTap: null, lastVel: 100, undone: false };
  const ec = $('#ed-canvas'), ex = ec.getContext('2d');
  const RW = 46, TH = 22, VH = 72; // pitch ruler width, bar ruler height, velocity lane height
  const SNAPS = ['off', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T'];
  SNAPS.forEach(s => $('#ed-snap').add(new Option(s === 'off' ? 'Off' : s, s)));

  const edRows = () => isDrums() ? DRUM_ROWS.length : 88;
  const rowH = () => isDrums() ? 34 : 22;
  const rowOfP = p => isDrums() ? Math.max(0, DRUM_ROWS.indexOf(p)) : 108 - p;
  const pOfRow = r => isDrums() ? DRUM_ROWS[clamp(r, 0, DRUM_ROWS.length - 1)] : clamp(108 - r, 21, 108);
  const noteBottom = () => ED.H - VH - 6;
  const xOf = q => RW + (q - ED.sx) * ED.pxq;
  const qOf = x => ED.sx + (x - RW) / ED.pxq;
  const yOfRow = r => TH + (r - ED.sy) * rowH();
  const rowOfY = y => Math.floor(ED.sy + (y - TH) / rowH());
  const snapKey = () => $('#ed-snap').value;
  const snapCell = () => (T.GRIDS[snapKey()] && T.GRIDS[snapKey()].cell) || 0.25;
  const snapQ = t => snapKey() === 'off' ? t : T.snap(t, snapKey(), trk().q.swing, barQ());
  function disp(n) { return n.lock ? n : T.quantizeNotes([n], trk().q, take.num, take.den, loopLen())[0]; }

  function openEditor() {
    if (TR.state !== 'idle') stopTransport();
    closeSheet();
    $('#editor').hidden = false;
    ED.open = true; ED.sel = -1;
    const g = trk().q.grid;
    $('#ed-snap').value = g !== 'off' ? g : isDrums() ? '1/16' : '1/8';
    fillTrackSelect();
    edSize(true);
  }
  function closeEditor() {
    if (TR.state !== 'idle') stopTransport();
    ED.open = false;
    $('#editor').hidden = true;
    renderAll();
  }
  function fillTrackSelect() {
    const s = $('#ed-track');
    s.innerHTML = '';
    take.tracks.forEach((tr, i) => s.add(new Option(trackLabel(tr, i) + ` (${tr.notes.length})`, i, false, i === take.cur)));
  }
  $('#ed-back').onclick = closeEditor;
  $('#ed-track').onchange = e => { take.cur = +e.target.value; settings.preset = trk().preset; saveSettings(); ED.sel = -1; edSize(true); };
  $('#ed-snap').onchange = () => drawEditor(null);
  $('#ed-play').onclick = () => { if (TR.state === 'idle') startTransport('play'); else stopTransport(); };
  $('#ed-undo').onclick = () => { if (undo()) { ED.sel = -1; fillTrackSelect(); drawEditor(null); } else toast('Nothing to undo'); };

  function edSize(fit) {
    const dpr = window.devicePixelRatio || 1;
    ED.W = ec.offsetWidth; ED.H = ec.offsetHeight;
    ec.width = Math.max(1, Math.round(ED.W * dpr));
    ec.height = Math.max(1, Math.round(ED.H * dpr));
    ex.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (fit) {
      const span = Math.min(loopLen(), 2 * barQ());
      ED.pxq = (ED.W - RW - 8) / span;
      ED.sx = 0;
      const notes = trk().notes;
      const vis = (noteBottom() - TH) / rowH();
      if (notes.length) {
        const rs = notes.map(n => rowOfP(n.p));
        ED.sy = (Math.min(...rs) + Math.max(...rs)) / 2 - vis / 2;
      } else ED.sy = isDrums() ? 0 : rowOfP(12 * (octave() + 1) + 6) - vis / 2;
    }
    clampView();
    drawEditor(null);
  }
  function clampView() {
    const L = loopLen(), w = ED.W - RW;
    ED.pxq = clamp(ED.pxq, w / (L + 0.25), 480);
    ED.sx = clamp(ED.sx, 0, Math.max(0, L + 0.25 - w / ED.pxq));
    const vis = (noteBottom() - TH) / rowH();
    ED.sy = clamp(ED.sy, 0, Math.max(0, edRows() - vis));
  }

  function noteName(p) { return isDrums() ? drumName(p) : T.NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1); }
  function posLabel(t) {
    const bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    const bar = Math.floor(t / bq) + 1, beat = (t % bq) / beatQ + 1;
    return `bar ${bar} beat ${(Math.round(beat * 100) / 100).toString()}`;
  }

  function drawEditor(playhead) {
    if (!ED.W) return;
    const W = ED.W, H = ED.H, L = loopLen(), bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    const nb = noteBottom(), rh = rowH(), drums = isDrums();
    ex.clearRect(0, 0, W, H);
    ex.fillStyle = css('--panel'); ex.fillRect(0, 0, W, H);

    // rows
    const r0 = Math.floor(ED.sy), r1 = Math.ceil(ED.sy + (nb - TH) / rh);
    ex.save(); ex.beginPath(); ex.rect(0, TH, W, nb - TH); ex.clip();
    ex.font = `600 ${drums ? 11 : 10}px ${css('--font-mono')}`; ex.textBaseline = 'middle';
    for (let r = r0; r <= r1 && r < edRows(); r++) {
      const y = yOfRow(r), p = pOfRow(r);
      const black = !drums && [1, 3, 6, 8, 10].includes(p % 12);
      ex.fillStyle = black ? css('--bg') : css('--panel');
      ex.globalAlpha = black ? 0.55 : 1;
      ex.fillRect(RW, y, W - RW, rh);
      ex.globalAlpha = 1;
      ex.fillStyle = (!drums && p % 12 === 0) ? css('--muted') : css('--line');
      ex.globalAlpha = (!drums && p % 12 === 0) ? 0.5 : 0.35;
      ex.fillRect(RW, Math.round(y + rh) - 0.5, W - RW, 1);
      ex.globalAlpha = 1;
      // ruler
      if (drums) { ex.fillStyle = css('--muted'); ex.fillText(drumName(p).slice(0, 7), 4, y + rh / 2); }
      else {
        ex.fillStyle = black ? css('--ebony') : css('--ivory');
        ex.fillRect(0, y + 0.5, RW - 4, rh - 1);
        if (take.key && settings.keyColors) {
          ex.fillStyle = rgb(tensionColor(T.tension(p % 12, take.key.tonic, take.key.mode)));
          ex.fillRect(RW - 8, y + 0.5, 4, rh - 1);
        }
        ex.fillStyle = black ? css('--muted') : '#6b6258';
        ex.fillText(p % 12 === 0 ? 'C' + (p / 12 - 1) : T.NOTE_NAMES[p % 12], 4, y + rh / 2);
      }
    }
    ex.restore();

    // time grid
    ex.save(); ex.beginPath(); ex.rect(RW, 0, W - RW, nb); ex.clip();
    const q0 = ED.sx, q1 = qOf(W);
    const sk = snapKey(), g = T.GRIDS[sk];
    if (g && g.cell && g.cell * ED.pxq > 5) {
      const pair = g.swing ? g.cell * 2 : g.cell, pts = g.swing ? [0, pair * trk().q.swing] : [0];
      ex.fillStyle = css('--line'); ex.globalAlpha = 0.45;
      for (let b = Math.floor(q0 / bq); b * bq <= q1; b++) {
        for (let qq = 0; qq < bq - 1e-6; qq += pair) for (const off of pts) ex.fillRect(Math.round(xOf(b * bq + qq + off)), TH, 1, nb - TH);
      }
      ex.globalAlpha = 1;
    }
    for (let qq = Math.floor(q0 / beatQ) * beatQ; qq <= q1; qq += beatQ) {
      const isBar = Math.abs(qq / bq - Math.round(qq / bq)) < 1e-6;
      ex.fillStyle = isBar ? css('--muted') : css('--line');
      ex.globalAlpha = isBar ? 0.7 : 0.9;
      ex.fillRect(Math.round(xOf(qq)), isBar ? 0 : TH, isBar ? 2 : 1, nb - (isBar ? 0 : TH));
      ex.globalAlpha = 1;
      if (isBar && qq < L - 1e-6) {
        ex.fillStyle = css('--fg'); ex.font = `700 11px ${css('--font-mono')}`; ex.textBaseline = 'middle';
        ex.fillText(String(Math.round(qq / bq) + 1), xOf(qq) + 5, TH / 2);
      }
    }
    if (xOf(L) < W) { ex.fillStyle = css('--bg'); ex.globalAlpha = 0.7; ex.fillRect(xOf(L), 0, W - xOf(L), H); ex.globalAlpha = 1; }
    ex.restore();

    // notes
    ex.save(); ex.beginPath(); ex.rect(RW, TH, W - RW, nb - TH); ex.clip();
    for (const tr of take.tracks) { // ghosts of the other tracks of the same kind
      if (tr === trk() || presetDrums(tr.preset) !== drums) continue;
      ex.fillStyle = css('--muted'); ex.globalAlpha = 0.3;
      for (const n of qNotes(tr)) roundRect(ex, xOf(n.t), yOfRow(rowOfP(n.p)) + 2, Math.max(4, n.d * ED.pxq - 1), rh - 4, 3);
    }
    ex.globalAlpha = 1;
    const notes = trk().notes;
    notes.forEach((n, i) => {
      const d = disp(n);
      const x = xOf(d.t), y = yOfRow(rowOfP(n.p)) + 2, w = Math.max(6, d.d * ED.pxq - 1), h = rh - 4;
      if (x > W || x + w < RW) return;
      ex.globalAlpha = 0.45 + 0.55 * (n.v / 127);
      ex.fillStyle = i === ED.sel ? css('--fg') : css('--amber');
      roundRect(ex, x, y, w, h, 4);
      ex.globalAlpha = 1;
      if (i === ED.sel) { // resize handle
        ex.fillStyle = css('--bg'); ex.fillRect(x + w - 6, y + 4, 2, h - 8);
      }
      if (w > 34 && h > 14 && !drums) {
        ex.fillStyle = css('--bg'); ex.font = `600 10px ${css('--font-mono')}`; ex.textBaseline = 'middle';
        ex.fillText(noteName(n.p), x + 4, y + h / 2);
      }
    });
    ex.restore();

    // velocity lane
    const vt = nb + 6;
    ex.fillStyle = css('--bg'); ex.fillRect(RW, vt, W - RW, VH);
    ex.fillStyle = css('--muted'); ex.font = `600 10px ${css('--font-ui')}`; ex.textBaseline = 'top';
    ex.fillText('VEL', 6, vt + 4);
    ex.save(); ex.beginPath(); ex.rect(RW, vt, W - RW, VH); ex.clip();
    notes.forEach((n, i) => {
      const d = disp(n), x = xOf(d.t), h = (VH - 6) * n.v / 127;
      ex.fillStyle = i === ED.sel ? css('--fg') : css('--amber');
      ex.globalAlpha = i === ED.sel ? 1 : 0.7;
      ex.fillRect(x, vt + VH - h, i === ED.sel ? 6 : 4, h);
      ex.beginPath(); ex.arc(x + (i === ED.sel ? 3 : 2), vt + VH - h, i === ED.sel ? 5 : 3, 0, 7); ex.fill();
    });
    ex.restore(); ex.globalAlpha = 1;

    if (playhead != null) {
      ex.fillStyle = css('--fg');
      const px = xOf(playhead);
      if (px >= RW && px <= W) ex.fillRect(Math.round(px) - 1, 0, 2, H);
      else if (TR.state !== 'idle') { ED.sx = Math.max(0, playhead - 0.25); clampView(); }
    }
    edInfo();
  }

  function edInfo() {
    const n = trk().notes[ED.sel];
    const has = !!n;
    ['#ed-left', '#ed-right', '#ed-up', '#ed-down', '#ed-vdown', '#ed-vup', '#ed-del'].forEach(s => $(s).disabled = !has);
    $('#ed-info').textContent = has
      ? `${noteName(n.p)} · ${posLabel(disp(n).t)} · length ${Math.round(disp(n).d / T.quartersPerBeat(take.den) * 100) / 100} beats · vel ${n.v}`
      : trk().notes.length ? 'Tap a note to select it. Drag to move, drag its right end to resize. Double-tap empty space to add.' : 'Double-tap to add a note.';
  }

  function edPoint(e) { const r = ec.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function noteAt(x, y) {
    const notes = trk().notes, rh = rowH();
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i], d = disp(n);
      const nx = xOf(d.t), ny = yOfRow(rowOfP(n.p)), w = Math.max(6, d.d * ED.pxq);
      if (x >= nx - 3 && x <= nx + w + 3 && y >= ny && y <= ny + rh) {
        const edge = !isDrums() && w > 16 && x > nx + w - Math.max(12, Math.min(22, w * 0.3));
        return { idx: i, edge };
      }
    }
    return null;
  }
  function pickVel(x) {
    const notes = trk().notes;
    if (notes[ED.sel] && Math.abs(xOf(disp(notes[ED.sel]).t) - x) < 18) return ED.sel;
    let best = -1, bd = 26;
    notes.forEach((n, i) => { const dd = Math.abs(xOf(disp(n).t) - x); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }
  function edChange() { if (!ED.undone) { pushUndo(); ED.undone = true; } }
  function preview(p, v) { A.unlock(); A.playNote(trk().preset, p, v || 100, A.ctx.currentTime + 0.005, 0.22); }
  function setVelFromY(i, y) {
    const vt = noteBottom() + 6;
    const v = clamp(Math.round(1 + 126 * (vt + VH - y) / (VH - 6)), 1, 127);
    trk().notes[i].v = v; ED.lastVel = v;
  }
  function addNoteAt(x, y) {
    if (y >= noteBottom()) return;
    const cellLen = snapKey() === 'off' ? 0.5 : snapCell();
    let t = snapKey() === 'off' ? qOf(x) : snapQ(qOf(x) - cellLen / 2);
    t = clamp(t, 0, loopLen() - 0.05);
    const p = pOfRow(rowOfY(y));
    edChange();
    trk().notes.push({ p, t: round(t), d: round(isDrums() ? 0.25 : Math.min(cellLen, loopLen() - t)), v: ED.lastVel, lock: true });
    ED.sel = trk().notes.length - 1;
    preview(p, ED.lastVel);
  }

  ec.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { ec.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    const pt = edPoint(e);
    ED.ptrs.set(e.pointerId, pt);
    if (ED.ptrs.size === 2) {
      const [a, b] = [...ED.ptrs.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ED.g = { type: 'pinch', d0: Math.max(20, Math.abs(a.x - b.x)), pxq: ED.pxq, qm: qOf(mx), my, sy: ED.sy };
      return;
    }
    if (ED.ptrs.size > 2) return;
    ED.undone = false;
    const { x, y } = pt;
    if (y > noteBottom()) {
      const i = pickVel(x);
      if (i >= 0) { ED.sel = i; edChange(); setVelFromY(i, y); ED.g = { type: 'vel', idx: i }; } else ED.g = null;
      drawEditor(null); return;
    }
    const hit = (x > RW && y > TH) ? noteAt(x, y) : null;
    if (hit) {
      const n = trk().notes[hit.idx], d = disp(n);
      ED.sel = hit.idx;
      ED.g = { type: hit.edge ? 'resize' : 'move', idx: hit.idx, x0: x, y0: y, t: d.t, d: d.d, p: n.p, moved: false };
      drawEditor(null); return;
    }
    ED.g = { type: 'pan', x0: x, y0: y, sx: ED.sx, sy: ED.sy, moved: false, empty: x > RW && y > TH };
  });
  ec.addEventListener('pointermove', e => {
    if (!ED.ptrs.has(e.pointerId)) return;
    const pt = edPoint(e);
    ED.ptrs.set(e.pointerId, pt);
    const g = ED.g;
    if (!g) return;
    if (g.type === 'pinch') {
      if (ED.ptrs.size < 2) return;
      const [a, b] = [...ED.ptrs.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ED.pxq = g.pxq * Math.max(20, Math.abs(a.x - b.x)) / g.d0;
      clampView();
      ED.sx = g.qm - (mx - RW) / ED.pxq;
      ED.sy = g.sy - (my - g.my) / rowH();
      clampView(); drawEditor(null); return;
    }
    if (g.type === 'vel') { setVelFromY(g.idx, pt.y); persistTake(); drawEditor(null); return; }
    const dx = pt.x - g.x0, dy = pt.y - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    g.moved = true;
    if (g.type === 'pan') {
      ED.sx = g.sx - dx / ED.pxq; ED.sy = g.sy - dy / rowH(); clampView(); drawEditor(null); return;
    }
    const n = trk().notes[g.idx], L = loopLen();
    edChange();
    if (g.type === 'move') {
      const t = clamp(snapQ(g.t + dx / ED.pxq), 0, L - 0.03);
      const p = pOfRow(rowOfP(g.p) + Math.round(dy / rowH()));
      if (p !== n.p) preview(p, n.v);
      n.p = p; n.t = round(t); n.d = round(Math.min(g.d, L - t)); n.lock = true;
    } else {
      const minLen = Math.min(snapCell(), 0.125);
      const end = clamp(snapQ(g.t + g.d + dx / ED.pxq), g.t + minLen, L);
      n.t = round(g.t); n.d = round(end - g.t); n.lock = true;
    }
    persistTake(); drawEditor(null);
  });
  function edUp(e) {
    if (!ED.ptrs.has(e.pointerId)) return;
    ED.ptrs.delete(e.pointerId);
    const g = ED.g;
    if (g && g.type === 'pinch') { if (ED.ptrs.size === 0) ED.g = null; else ED.g = null; return; }
    if (g && (g.type === 'move' || g.type === 'resize') && !g.moved) preview(trk().notes[g.idx].p, trk().notes[g.idx].v);
    if (g && g.type === 'pan' && !g.moved && g.empty) {
      const now = performance.now(), lt = ED.lastTap;
      if (lt && now - lt.time < 350 && Math.hypot(lt.x - g.x0, lt.y - g.y0) < 28) { addNoteAt(g.x0, g.y0); ED.lastTap = null; persistTake(); }
      else { ED.sel = -1; ED.lastTap = { time: now, x: g.x0, y: g.y0 }; }
    }
    ED.g = null;
    drawEditor(null);
  }
  ec.addEventListener('pointerup', edUp);
  ec.addEventListener('pointercancel', edUp);
  ec.addEventListener('contextmenu', e => e.preventDefault());

  function edNudge(dt, dr, dv) {
    const n = trk().notes[ED.sel];
    if (!n) return;
    pushUndo();
    if (dt) { const d = disp(n); const t = clamp(d.t + dt, 0, loopLen() - 0.03); n.t = round(t); n.d = round(Math.min(d.d, loopLen() - t)); n.lock = true; }
    if (dr) { n.p = pOfRow(rowOfP(n.p) + dr); preview(n.p, n.v); }
    if (dv) { n.v = clamp(n.v + dv, 1, 127); ED.lastVel = n.v; }
    persistTake(); drawEditor(null);
  }
  function edDelete() {
    if (!trk().notes[ED.sel]) return;
    pushUndo(); trk().notes.splice(ED.sel, 1); ED.sel = -1; persistTake(); drawEditor(null);
  }
  function edZoom(f) { const qm = qOf(RW + (ED.W - RW) / 2); ED.pxq *= f; clampView(); ED.sx = qm - (ED.W - RW) / 2 / ED.pxq; clampView(); drawEditor(null); }
  $('#ed-left').onclick = () => edNudge(-snapCell(), 0, 0);
  $('#ed-right').onclick = () => edNudge(snapCell(), 0, 0);
  $('#ed-up').onclick = () => edNudge(0, -1, 0);
  $('#ed-down').onclick = () => edNudge(0, 1, 0);
  $('#ed-vdown').onclick = () => edNudge(0, 0, -10);
  $('#ed-vup').onclick = () => edNudge(0, 0, 10);
  $('#ed-del').onclick = edDelete;
  $('#ed-zin').onclick = () => edZoom(1.5);
  $('#ed-zout').onclick = () => edZoom(1 / 1.5);
  function edKey(e) {
    const k = e.key;
    if (k === 'Escape') closeEditor();
    else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); edDelete(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); edNudge(-snapCell(), 0, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); edNudge(snapCell(), 0, 0); }
    else if (k === 'ArrowUp') { e.preventDefault(); edNudge(0, -1, 0); }
    else if (k === 'ArrowDown') { e.preventDefault(); edNudge(0, 1, 0); }
    else if (e.code === 'Space') { e.preventDefault(); $('#ed-play').click(); }
    else if ((k === 'z') && (e.metaKey || e.ctrlKey)) $('#ed-undo').click();
  }

  // =================================================================
  // Export
  // =================================================================
  function safeName(s) { return (s || 'take').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'take'; }
  function takeMidi(t) {
    let next = 0;
    const tracks = [];
    for (const tr of t.tracks) {
      if (!tr.notes.length) continue;
      const drums = presetDrums(tr.preset);
      if (next === 9) next++;
      tracks.push({
        name: A.PRESETS[tr.preset].label, notes: qNotes(tr, t),
        channel: drums ? 9 : next++, program: drums ? null : A.PRESETS[tr.preset].gm,
      });
    }
    const k = t.key || (() => { const e = T.estimateKey(T.analyze(melodicNotes(t), t.num, t.den)); return e && { tonic: e.tonic, mode: e.mode }; })();
    return M.writeSong({
      name: t.name, bpm: t.bpm, num: t.num, den: t.den, tracks,
      keySig: k ? T.keySignature(k.tonic, k.mode) : null, lengthQ: loopLen(t),
    });
  }
  const takeFileName = t => `${safeName(t.name)} ${t.bpm}bpm.mid`;

  async function exportTakes(list, label) {
    list = list.filter(t => noteCount(t));
    if (!list.length) { toast('Nothing to export yet'); return; }
    const files = list.map(t => ({ name: takeFileName(t), data: takeMidi(t), mime: 'audio/midi' }));
    await deliver(files, safeName(label));
  }

  // Hand files to the person: claude.ai download prompt (MIDI travels in a
  // .zip there), share sheet on phones, then a plain browser download.
  async function deliver(files, baseName, kind) {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) {
        try {
          if (kind === 'json') await dl.save({ filename: files[0].name, data: new Blob([files[0].data]) });
          else await dl.save({ filename: baseName + '.zip', data: new Blob([M.zip(files)]) });
          toast('Saved');
        } catch (e) {
          if (e && e.code !== 'declined') toast('Could not save: ' + (e.message || e.code));
        }
        return;
      }
    }
    const fileObjs = files.map(f => new File([f.data], f.name, { type: f.mime || 'application/octet-stream' }));
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare && navigator.canShare({ files: fileObjs })) {
      try { await navigator.share({ files: fileObjs, title: baseName }); return; } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const one = files.length === 1 ? fileObjs[0] : new File([M.zip(files)], baseName + '.zip', { type: 'application/zip' });
    const url = URL.createObjectURL(one);
    const a = document.createElement('a');
    a.href = url; a.download = one.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  $('#btn-share').onclick = () => exportTakes([take], take.name);

  // =================================================================
  // Library
  // =================================================================
  const lib = { tab: 'projects', projectId: null };
  const anCache = new Map();
  function analysisOf(t) {
    const key = t.id + ':' + t.updated;
    if (!anCache.has(key)) {
      const notes = melodicNotes(t);
      const an = notes.length ? T.analyze(notes, t.num, t.den) : null;
      anCache.set(key, { an, est: T.estimateKey(an) });
    }
    return anCache.get(key);
  }
  function sortedProjects() { return [...projects.values()].sort((a, b) => b.updated - a.updated); }

  $('#btn-library').onclick = () => openLibrary();
  $('#lib-back').onclick = () => {
    if (lib.tab === 'projects' && lib.projectId) { lib.projectId = null; renderLibrary(); return; }
    $('#library').hidden = true;
  };
  function openLibrary() {
    if (TR.state !== 'idle') return;
    $('#library').hidden = false;
    lib.projectId = null;
    renderLibrary();
  }
  segOn('#lib-tabs', v => { lib.tab = v; lib.projectId = null; renderLibrary(); });
  (function () {
    const tonic = $('#f-tonic');
    T.NOTE_NAMES.forEach((n, i) => tonic.add(new Option(n, String(i))));
    const mode = $('#f-mode');
    T.MODE_ORDER.forEach(m => mode.add(new Option(T.MODES[m].label, m)));
  })();
  ['#q-text', '#f-meter', '#f-bpm-min', '#f-bpm-max', '#f-mode', '#f-sort'].forEach(s => $(s).addEventListener('input', renderLibrary));
  $('#f-tonic').addEventListener('input', () => {
    if ($('#f-tonic').value !== '') $('#f-sort').value = 'key';
    else if ($('#f-sort').value === 'key') $('#f-sort').value = 'new';
    renderLibrary();
  });
  $('#lib-new-project').onclick = () => {
    const p = newProject('Project ' + (projects.size + 1));
    persistProject(p);
    settings.projectId = p.id; saveSettings();
    lib.tab = 'projects'; lib.projectId = p.id;
    renderLibrary();
    setTimeout(() => { const i = $('#proj-rename'); if (i) { i.focus(); i.select(); } }, 50);
  };

  function takeRow(t, extra) {
    const b = document.createElement('button');
    b.className = 'item' + (t.id === take.id ? ' current' : '');
    const p = projects.get(t.projectId);
    const { est } = analysisOf(t);
    const keyTxt = t.key ? keyLabel(t.key) : est ? est.label + (est.confident ? '' : '?') : 'Drums';
    const sounds = [...new Set(t.tracks.filter(tr => tr.notes.length).map(tr => A.PRESETS[tr.preset].label))].join(' + ') || A.PRESETS[t.tracks[0].preset].label;
    const date = new Date(t.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    b.innerHTML = `<span class="name"></span><span class="side"></span><span class="meta"></span>`;
    b.querySelector('.name').textContent = t.name;
    b.querySelector('.meta').textContent = `${t.bpm} BPM · ${t.num}/${t.den} · ${keyTxt} · ${sounds}` + (lib.tab === 'all' && p ? ' · ' + p.name : '');
    const side = b.querySelector('.side');
    if (extra) {
      side.innerHTML = `<span class="score">${Math.round(extra.score * 100)}</span>match`;
      const why = document.createElement('span');
      why.className = 'why';
      const outs = extra.outside.slice(0, 4).map(o => T.spellOutside(o.pc, extra.tonic, extra.mode) + ' ' + Math.round(o.share * 100) + '%').join(', ');
      why.innerHTML = `<b>${Math.round(extra.fit * 100)}%</b> in key · center ${T.NOTE_NAMES[extra.tonic]} ${extra.centerRel > 0.8 ? 'likely' : extra.centerRel > 0.3 ? 'possible' : 'unlikely'}` +
        (extra.outside.length ? ` · outside: ${outs}` : ' · nothing outside');
      b.appendChild(why);
    } else side.textContent = date;
    b.onclick = () => loadTake(t.id);
    return b;
  }

  function loadTake(id) {
    const t = takes.get(id);
    if (!t) return;
    take = t;
    undoStack.length = 0;
    Object.assign(settings, { takeId: t.id, projectId: t.projectId, preset: trk().preset, bpm: t.bpm, num: t.num, den: t.den, bars: t.bars, q: { ...trk().q } });
    saveSettings();
    $('#library').hidden = true;
    renderAll();
  }

  function filteredTakes(all) {
    const text = $('#q-text').value.trim().toLowerCase();
    const meter = $('#f-meter').value;
    const lo = parseFloat($('#f-bpm-min').value), hi = parseFloat($('#f-bpm-max').value);
    const tonic = $('#f-tonic').value;
    const mode = $('#f-mode').value || 'major';
    const sort = $('#f-sort').value;
    const rows = all.filter(t => {
      if (text) {
        const p = projects.get(t.projectId);
        if (!(t.name.toLowerCase().includes(text) || (p && p.name.toLowerCase().includes(text)))) return false;
      }
      if (meter && `${t.num}/${t.den}` !== meter) return false;
      if (!isNaN(lo) && t.bpm < lo) return false;
      if (!isNaN(hi) && t.bpm > hi) return false;
      return true;
    }).map(t => ({ t, m: null }));
    if (tonic !== '') {
      for (const r of rows) {
        const { an } = analysisOf(r.t);
        const k = an && T.keyMatch(an, +tonic, mode);
        if (k) r.m = { ...k, tonic: +tonic, mode };
      }
    }
    const by = {
      new: (a, b) => b.t.created - a.t.created,
      old: (a, b) => a.t.created - b.t.created,
      'bpm-asc': (a, b) => a.t.bpm - b.t.bpm,
      'bpm-desc': (a, b) => b.t.bpm - a.t.bpm,
      name: (a, b) => a.t.name.localeCompare(b.t.name, undefined, { numeric: true }),
      key: (a, b) => (b.m ? b.m.score : -1) - (a.m ? a.m.score : -1),
    }[sort] || ((a, b) => b.t.created - a.t.created);
    rows.sort(by);
    return rows;
  }

  function renderLibrary() {
    segSet('#lib-tabs', lib.tab);
    const list = $('#lib-list');
    list.innerHTML = '';
    const meters = [...new Set([...takes.values()].map(t => `${t.num}/${t.den}`))].sort();
    const fm = $('#f-meter'), cur = fm.value;
    fm.innerHTML = '<option value="">Any</option>';
    meters.forEach(m => fm.add(new Option(m, m, false, m === cur)));
    $('#store-note').textContent = store ? {
      claude: 'Saved to your Claude account (private to you).',
      idb: 'Saved on this device. Back up now and then.',
      memory: 'Storage is blocked here: takes vanish on reload. Back up!',
    }[store.kind] : 'Loading…';
    $('#lib-search').hidden = !(lib.tab === 'all' || !!lib.projectId);

    if (lib.tab === 'projects' && !lib.projectId) {
      $('#lib-title').textContent = 'Projects';
      for (const p of sortedProjects()) {
        const n = [...takes.values()].filter(t => t.projectId === p.id).length;
        const b = document.createElement('button');
        b.className = 'item' + (p.id === settings.projectId ? ' current' : '');
        b.innerHTML = '<span class="name"></span><span class="side"></span><span class="meta"></span>';
        b.querySelector('.name').textContent = p.name;
        b.querySelector('.meta').textContent = `${n} ${n === 1 ? 'take' : 'takes'}` + (p.id === settings.projectId ? ' · new takes go here' : '');
        b.querySelector('.side').textContent = new Date(p.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        b.onclick = () => { lib.projectId = p.id; renderLibrary(); };
        list.appendChild(b);
      }
      return;
    }

    let pool = [...takes.values()];
    if (lib.tab === 'projects') {
      const p = projects.get(lib.projectId);
      $('#lib-title').textContent = p.name;
      pool = pool.filter(t => t.projectId === p.id);
      const bar = document.createElement('div');
      bar.className = 'proj-actions';
      bar.innerHTML = `<input id="proj-rename" maxlength="60" aria-label="Project name">
        <button class="chip" id="proj-use">${p.id === settings.projectId ? 'New takes go here' : 'Record here'}</button>
        <button class="chip" id="proj-export">Export MIDI</button>
        <button class="chip" id="proj-delete">Delete</button>`;
      list.appendChild(bar);
      const inp = bar.querySelector('#proj-rename');
      inp.value = p.name;
      inp.onchange = () => { const v = inp.value.trim(); if (v) { p.name = v; persistProject(p); renderHeader(); $('#lib-title').textContent = v; } };
      bar.querySelector('#proj-use').onclick = () => {
        settings.projectId = p.id; saveSettings();
        if (!noteCount(take)) take.projectId = p.id;
        renderHeader(); renderLibrary(); toast('New takes go to ' + p.name);
      };
      bar.querySelector('#proj-export').onclick = () => exportTakes(pool, p.name);
      bar.querySelector('#proj-delete').onclick = e => {
        if (pool.length) { toast('Move or delete its takes first'); return; }
        if (projects.size <= 1) { toast('Keep at least one project'); return; }
        twoStep(e.currentTarget, 'Tap again', async () => {
          projects.delete(p.id);
          if (store) await store.remove(p.id).catch(() => {});
          if (settings.projectId === p.id) { settings.projectId = sortedProjects()[0].id; saveSettings(); }
          lib.projectId = null; renderLibrary(); renderHeader();
        });
      };
    } else {
      $('#lib-title').textContent = 'All takes';
    }
    const rows = filteredTakes(pool);
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = pool.length ? 'No takes match these filters.' : 'No takes yet. Record one from the keys.';
      list.appendChild(e);
    }
    for (const r of rows) list.appendChild(takeRow(r.t, r.m));
  }

  // --- backup / restore
  $('#btn-backup').onclick = () => {
    const docs = [...projects.values(), ...takes.values()];
    const data = JSON.stringify({ app: 'noodle', version: 2, exported: new Date().toISOString(), docs });
    const stamp = new Date().toISOString().slice(0, 10);
    deliver([{ name: `noodle-backup-${stamp}.json`, data: new TextEncoder().encode(data), mime: 'application/json' }], 'noodle-backup-' + stamp, 'json');
  };
  $('#restore-file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || j.app !== 'noodle' || !Array.isArray(j.docs)) throw new Error('not a Noodle backup');
      let n = 0;
      for (const d of j.docs) {
        if (!d || !d.id || (d.kind !== 'take' && d.kind !== 'project')) continue;
        if (d.kind === 'take') takes.set(d.id, migrate(d)); else projects.set(d.id, d);
        if (store) await store.put(d);
        n++;
      }
      toast(`Restored ${n} items`);
      renderLibrary();
    } catch (err) { toast('Restore failed: ' + err.message); }
  };

  // =================================================================
  // Boot
  // =================================================================
  function boot() {
    const p0 = newProject('Ideas');
    projects.set(p0.id, p0);
    settings.projectId = settings.projectId || p0.id;
    take = newTake(settings.projectId);
    applyRotation();
    renderAll();
    const first = () => {
      A.unlock(); A.setClickVolume(settings.clickVol);
      document.removeEventListener('pointerdown', first, true);
      document.removeEventListener('touchend', first, true);
    };
    document.addEventListener('pointerdown', first, true);
    document.addEventListener('touchend', first, true);

    window.NoodleStore.openStore().then(async s => {
      store = s;
      const docs = await s.loadAll();
      const draft = noteCount(take) ? take : null; // recorded before the store answered
      projects.clear(); takes.clear();
      for (const d of docs) {
        if (d.kind === 'project') projects.set(d.id, d);
        else if (d.kind === 'take') takes.set(d.id, migrate(d));
      }
      if (!projects.size) persistProject(p0);
      if (!projects.has(settings.projectId)) settings.projectId = sortedProjects()[0].id;
      if (draft) {
        draft.projectId = projects.has(draft.projectId) ? draft.projectId : settings.projectId;
        take = draft; persistTake(draft, true);
      } else if (TR.state === 'idle' && !ED.open) {
        take = (settings.takeId && takes.get(settings.takeId)) || newTake(settings.projectId);
      }
      saveSettings();
      if (TR.state === 'idle') renderAll();
      if (!$('#library').hidden) renderLibrary();
    });

    // Offline support when installed as a web app (not inside claude.ai).
    if ('serviceWorker' in navigator && !window.claude && document.querySelector('link[rel=manifest]') && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // Test hook (used by the automated browser tests).
  window.__noodle = {
    get take() { return take; }, get takes() { return takes; }, get projects() { return projects; },
    get transport() { return TR; }, get store() { return store; }, get editor() { return ED; },
    settings: () => settings, takeMidi, songEvents, hitAt, sense,
  };
  boot();
})();
