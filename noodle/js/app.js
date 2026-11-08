/* Noodle — app: state, transport, keyboard, roll, sheets, library. */
(function () {
  'use strict';
  const T = window.NoodleTheory, A = window.NoodleAudio, M = window.NoodleMidi;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const round = x => Math.round(x * 10000) / 10000;

  // ---------------- settings (per-device convenience) ----------------
  const DEFAULTS = {
    bpm: 92, num: 4, den: 4, bars: 4, countIn: 1, metro: true, clickVol: 0.6,
    loop: false, overdub: 'new', latencyMs: 0, vel: 'fixed', layout: 'piano',
    preset: 'pluck', oct: {}, q: { grid: 'off', swing: 0.5, strength: 1, ends: false },
    projectId: null, takeId: null,
  };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('noodle.settings') || '{}') }; } catch (e) { /* storage blocked */ }
  function saveSettings() { try { localStorage.setItem('noodle.settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ } }

  // ---------------- data ----------------
  let store = null;
  const projects = new Map();
  const takes = new Map();
  let take = null;         // current take (always exists after boot)
  const undoStack = [];    // snapshots of take.notes before each pass

  function newTake(projectId) {
    const n = [...takes.values()].filter(t => t.projectId === projectId).length + 1;
    return {
      id: 't' + uid(), kind: 'take', projectId, name: 'Take ' + n,
      created: Date.now(), updated: Date.now(),
      bpm: settings.bpm, num: settings.num, den: settings.den, bars: settings.bars,
      preset: settings.preset, notes: [], q: { ...settings.q },
    };
  }
  function newProject(name) {
    return { id: 'p' + uid(), kind: 'project', name, created: Date.now(), updated: Date.now() };
  }

  let saveTimer = null;
  function persistTake(t, now) {
    t = t || take;
    if (!t.notes.length && !takes.has(t.id)) return; // never store empty, unsaved takes
    t.updated = Date.now();
    takes.set(t.id, t);
    clearTimeout(saveTimer);
    const write = () => store && store.put(t).catch(err => toast('Could not save: ' + (err && err.message || err)));
    if (now) write(); else saveTimer = setTimeout(write, 500);
  }
  function persistProject(p) {
    p.updated = Date.now();
    projects.set(p.id, p);
    store && store.put(p).catch(err => toast('Could not save: ' + (err && err.message || err)));
  }

  // Derived numbers for the current take.
  const barQ = () => T.barQuarters(take.num, take.den);
  const loopLen = () => take.bars * barQ();
  const spq = () => T.secPerQuarter(take.bpm, take.den);
  const isDrums = () => !!A.PRESETS[take.preset].drums;
  const quantized = t => T.quantizeNotes((t || take).notes, (t || take).q, (t || take).num, (t || take).den, (t || take).bars * T.barQuarters((t || take).num, (t || take).den));

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
    state: 'idle', // idle | count | rec | play
    t0: 0, clickPos: 0, playList: [], playIdx: 0, playIter: 0,
    timer: null, raf: null, held: new Map(), recTake: null, prevTake: null, loop: false,
  };

  function startTransport(mode) {
    A.unlock();
    const ctx = A.ctx;
    const bq = barQ();
    const countIn = mode === 'rec' && settings.countIn ? bq : 0;
    TR.loop = settings.loop;
    TR.t0 = ctx.currentTime + 0.15 + countIn * spq();
    TR.clickPos = -countIn;
    TR.playIter = 0; TR.playIdx = 0;
    TR.held.clear();

    if (mode === 'rec') {
      if (settings.overdub === 'add') {
        undoStack.push(take.notes.map(n => ({ ...n })));
      } else {
        TR.prevTake = take;
        take = newTake(settings.projectId);
        undoStack.length = 0;
      }
      TR.playList = quantized();
      document.body.classList.add('recording');
    } else {
      TR.playList = quantized();
      document.body.classList.add('playing');
    }
    TR.state = countIn ? 'count' : mode;
    TR.mode = mode;
    renderHeader();
    sizeRoll();
    wakeLock(true);
    TR.timer = setInterval(tick, 25);
    tick();
    TR.raf = requestAnimationFrame(frame);
  }

  function stopTransport() {
    if (TR.state === 'idle') return;
    const ctx = A.ctx;
    clearInterval(TR.timer);
    cancelAnimationFrame(TR.raf);
    // Close any notes still held when recording ends.
    for (const key of [...TR.held.keys()]) captureOff(key, null, ctx.currentTime);
    const wasRec = TR.mode === 'rec';
    TR.state = 'idle';
    A.allOff();
    document.body.classList.remove('recording', 'playing');
    $('#countdown').hidden = true;
    wakeLock(false);
    if (wasRec) {
      if (take.notes.length) {
        persistTake(take, true);
        settings.takeId = take.id; saveSettings();
        toast(settings.overdub === 'add' ? 'Layer added' : 'Saved ' + take.name);
      } else if (TR.prevTake && settings.overdub !== 'add') {
        take = TR.prevTake; // nothing played: keep the previous take loaded
      }
      TR.prevTake = null;
    }
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
    const recording = TR.mode === 'rec';

    // metronome (count-in always clicks)
    while (TR.t0 + TR.clickPos * s < horizon) {
      if (!TR.loop && TR.clickPos >= L - 1e-6) break;
      const at = TR.t0 + TR.clickPos * s;
      if ((settings.metro || TR.clickPos < 0) && at >= now - 0.005) A.click(at, clickLevel(TR.clickPos));
      TR.clickPos += beatQ;
    }

    // playback (and, while recording, the existing layers)
    let guard = 0;
    while (guard++ < 2000) {
      if (TR.playIdx >= TR.playList.length) {
        if (!TR.loop) break;
        const nextStart = TR.t0 + (TR.playIter + 1) * L * s;
        if (nextStart >= horizon) break;
        TR.playIter++; TR.playIdx = 0;
        TR.playList = quantized(); // picks up the pass just recorded
        if (!TR.playList.length) break;
        continue;
      }
      const n = TR.playList[TR.playIdx];
      const at = TR.t0 + (TR.playIter * L + n.t) * s;
      if (at >= horizon) break;
      if (at >= now - 0.01) A.playNote(take.preset, n.p, n.v, at, n.d * s);
      TR.playIdx++;
    }

    if (TR.state === 'count' && now >= TR.t0) TR.state = 'rec';
    if (!TR.loop && now >= TR.t0 + L * s) stopTransport();
  }

  // Playhead + counter + count-in display.
  function frame() {
    if (TR.state === 'idle') return;
    const ctx = A.ctx;
    const s = spq(), L = loopLen(), bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    // What the listener is hearing right now.
    const heard = A.heardTime(performance.now());
    const q = (heard - TR.t0) / s;
    const cd = $('#countdown');
    if (q < 0) {
      cd.hidden = false;
      cd.textContent = String(Math.ceil(-q / beatQ));
      drawRoll(null);
    } else {
      cd.hidden = true;
      const pos = TR.loop ? q % L : Math.min(q, L);
      const bar = Math.floor(pos / bq) + 1;
      const beat = Math.floor((pos % bq) / beatQ) + 1;
      $('#counter').textContent = bar + '.' + beat + (TR.loop && TR.mode === 'rec' ? '  ×' + (Math.floor(q / L) + 1) : '');
      drawRoll(pos);
    }
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
  function beatAt(ctxTime) { return (ctxTime - TR.t0) / spq(); }
  function heardNow(evTs) { return A.heardTime(evTs) - settings.latencyMs / 1000; }

  function captureOn(key, p, v, evTs) {
    if (TR.mode !== 'rec' || TR.state === 'idle') return;
    let b = beatAt(heardNow(evTs));
    if (b < -0.3) return;            // noodling during the count-in
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
    let t = TR.loop ? h.start % L : h.start;
    let d = isDrums() ? 0.25 : Math.max(0.05, end - h.start);
    d = Math.min(d, L - t);
    if (d <= 0) return;
    take.notes.push({ p: h.p, t: round(t), d: round(d), v: Math.round(h.v) });
  }

  // =================================================================
  // Keyboard
  // =================================================================
  const kb = $('#keyboard');
  const pointers = new Map(); // pointerId -> {el, note}

  function octave() {
    const d = A.PRESETS[take.preset].oct || 4;
    return settings.oct[take.preset] != null ? settings.oct[take.preset] : d;
  }

  function buildKeyboard() {
    kb.innerHTML = '';
    document.body.classList.toggle('drums', isDrums());
    if (isDrums()) {
      const g = document.createElement('div');
      g.className = 'pads kit';
      for (const d of A.DRUMS) {
        const b = document.createElement('div');
        b.className = 'pad'; b.dataset.note = d.note; b.textContent = d.name;
        g.appendChild(b);
      }
      kb.appendChild(g);
      return;
    }
    const base = 12 * (octave() + 1);
    $('#oct-label').textContent = 'C' + octave();
    if (settings.layout === 'pads') {
      const g = document.createElement('div');
      g.className = 'pads melodic';
      const order = [8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]; // bottom row = C..D#
      for (const i of order) {
        const b = document.createElement('div');
        const black = [1, 3, 6, 8, 10].includes(i);
        b.className = 'pad' + (black ? ' dark' : '') + (i === 0 ? ' root' : '');
        b.dataset.note = base + i;
        b.textContent = T.NOTE_NAMES[i] + (i === 0 ? octave() : '');
        g.appendChild(b);
      }
      kb.appendChild(g);
      return;
    }
    const piano = document.createElement('div');
    piano.className = 'piano';
    const whites = [0, 2, 4, 5, 7, 9, 11, 12];
    whites.forEach((semi, i) => {
      const k = document.createElement('div');
      k.className = 'wkey' + (semi % 12 === 0 ? ' root' : '');
      k.dataset.note = base + semi;
      k.textContent = semi % 12 === 0 ? 'C' + (octave() + semi / 12) : T.NOTE_NAMES[semi];
      piano.appendChild(k);
    });
    const blacks = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]; // [semitone, white index to the right]
    for (const [semi, wi] of blacks) {
      const k = document.createElement('div');
      k.className = 'bkey';
      k.dataset.note = base + semi;
      k.style.left = `calc(${(wi / 8) * 100}% - ${(0.62 / 8 / 2) * 100}% - 1.5px)`;
      k.style.width = `${(0.62 / 8) * 100}%`;
      piano.appendChild(k);
    }
    kb.appendChild(piano);
  }

  function keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest && el.closest('[data-note]');
  }

  function velocityFor(el, y) {
    if (settings.vel !== 'y') return isDrums() ? 110 : 100;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (y - r.top) / r.height));
    return Math.round(40 + 87 * f);
  }

  function press(id, el, e) {
    const note = +el.dataset.note;
    const v = velocityFor(el, e.clientY);
    A.noteOn(take.preset, note, v, null, 'k' + id);
    el.classList.add('down');
    pointers.set(id, { el, note });
    captureOn('k' + id, note, v, e.timeStamp);
  }
  function release(id, e) {
    const p = pointers.get(id);
    if (!p) return;
    pointers.delete(id);
    p.el.classList.remove('down');
    A.noteOff('k' + id);
    captureOff('k' + id, e ? e.timeStamp : performance.now());
  }

  kb.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!A.started || A.ctx.state !== 'running') A.unlock();
    const el = keyAt(e.clientX, e.clientY);
    if (!el) return;
    try { kb.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    press(e.pointerId, el, e);
  });
  kb.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p || isDrums()) return;
    const el = keyAt(e.clientX, e.clientY);
    if (el && el !== p.el) { release(e.pointerId, e); press(e.pointerId, el, e); }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => kb.addEventListener(t, e => release(e.pointerId, e)));
  kb.addEventListener('contextmenu', e => e.preventDefault());

  // Computer keyboard: A W S E D F T G Y H U J K = C..C
  const KEYMAP = 'awsedftgyhujk';
  document.addEventListener('keydown', e => {
    if (e.repeat || e.metaKey || e.ctrlKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); return; }
    if (e.key === 'r') { $('#btn-rec').click(); return; }
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i < 0) return;
    const el = isDrums() ? kb.querySelectorAll('[data-note]')[i] : kb.querySelector(`[data-note="${12 * (octave() + 1) + i}"]`);
    if (!el) return;
    A.unlock();
    const r = el.getBoundingClientRect();
    press('key' + e.key, el, { clientY: r.top + r.height * 0.8, timeStamp: e.timeStamp });
  });
  document.addEventListener('keyup', e => {
    if (KEYMAP.includes(e.key.toLowerCase())) release('key' + e.key, e);
  });

  $('#oct-down').onclick = () => setOct(octave() - 1);
  $('#oct-up').onclick = () => setOct(octave() + 1);
  function setOct(o) {
    settings.oct[take.preset] = Math.max(0, Math.min(7, o));
    saveSettings(); buildKeyboard();
  }

  // =================================================================
  // Piano roll
  // =================================================================
  const canvas = $('#roll');
  const cx = canvas.getContext('2d');
  let rollW = 0, rollH = 0;
  function sizeRoll() {
    requestAnimationFrame(() => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      rollW = r.width; rollH = r.height;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRoll(null);
    });
  }
  window.addEventListener('resize', sizeRoll);

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawRoll(playhead) {
    if (!rollW) return;
    const W = rollW, H = rollH, L = loopLen(), bq = barQ(), beatQ = T.quartersPerBeat(take.den);
    const x = q => (q / L) * W;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = css('--panel'); cx.fillRect(0, 0, W, H);
    // alternate bar shading
    for (let b = 0; b < take.bars; b++) {
      if (b % 2) { cx.fillStyle = css('--panel-2'); cx.globalAlpha = 0.45; cx.fillRect(x(b * bq), 0, x(bq), H); cx.globalAlpha = 1; }
    }
    // quantize grid
    const g = T.GRIDS[take.q.grid];
    if (g && g.cell && x(g.cell) > 4) {
      cx.strokeStyle = css('--line'); cx.globalAlpha = 0.35; cx.lineWidth = 1;
      for (let b = 0; b < take.bars; b++) {
        for (let q = 0; q < bq - 1e-6;) {
          const pair = g.swing ? g.cell * 2 : g.cell;
          const pts = g.swing ? [0, pair * take.q.swing] : [0];
          for (const off of pts) { const xx = Math.round(x(b * bq + q + off)) + 0.5; cx.beginPath(); cx.moveTo(xx, 0); cx.lineTo(xx, H); cx.stroke(); }
          q += pair;
        }
      }
      cx.globalAlpha = 1;
    }
    // beats and bars
    for (let q = 0; q <= L + 1e-6; q += beatQ) {
      const isBar = Math.abs(q / bq - Math.round(q / bq)) < 1e-6;
      cx.strokeStyle = isBar ? css('--muted') : css('--line');
      cx.globalAlpha = isBar ? 0.6 : 0.8;
      const xx = Math.round(x(q)) + 0.5;
      cx.beginPath(); cx.moveTo(xx, 0); cx.lineTo(xx, H); cx.stroke();
    }
    cx.globalAlpha = 1;

    const notes = take.notes;
    $('#roll-empty').hidden = notes.length > 0 || TR.state !== 'idle';
    if (notes.length) {
      // vertical layout
      let rows, rowOf;
      if (isDrums()) {
        const order = A.DRUMS.map(d => d.note).reverse();
        rows = order.length; rowOf = p => Math.max(0, order.indexOf(p));
      } else {
        let lo = Infinity, hi = -Infinity;
        for (const n of notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
        if (hi - lo < 11) { const pad = (11 - (hi - lo)) / 2; lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad); }
        rows = hi - lo + 1; rowOf = p => p - lo;
      }
      const rh = (H - 8) / rows;
      const y = r => H - 4 - (r + 1) * rh;
      const qn = quantized();
      const qOn = take.q.grid !== 'off' && take.q.strength > 0;
      if (qOn) { // ghost of what was actually played
        cx.strokeStyle = css('--muted'); cx.globalAlpha = 0.5; cx.lineWidth = 1;
        for (const n of notes) cx.strokeRect(x(n.t) + 0.5, y(rowOf(n.p)) + 0.5, Math.max(2, x(n.d) - 1), Math.max(2, rh - 1));
        cx.globalAlpha = 1;
      }
      cx.fillStyle = css('--amber');
      for (const n of qn) {
        const w = Math.max(3, x(n.d) - 1), hh = Math.max(2, rh - 1);
        cx.globalAlpha = 0.55 + 0.45 * (n.v / 127);
        roundRect(x(n.t), y(rowOf(n.p)), w, hh, Math.min(3, hh / 2));
      }
      cx.globalAlpha = 1;
    }
    if (playhead != null) {
      cx.fillStyle = TR.mode === 'rec' ? css('--rec') : css('--fg');
      cx.fillRect(Math.round(x(playhead)) - 1, 0, 2, H);
    }
  }
  function roundRect(x, y, w, h, r) {
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(x, y, w, h, r); else cx.rect(x, y, w, h);
    cx.fill();
  }

  // =================================================================
  // Header / chips / transport buttons
  // =================================================================
  function renderHeader() {
    $('#take-name').textContent = take.name;
    const p = projects.get(take.projectId) || projects.get(settings.projectId);
    $('#project-name').textContent = p ? p.name : '';
    $('#sound-label').textContent = A.PRESETS[take.preset].label;
    $('#chip-bpm').innerHTML = `${take.bpm} <small>BPM</small>`;
    $('#chip-meter').textContent = `${take.num}/${take.den}`;
    $('#chip-bars').innerHTML = `${take.bars} <small>${take.bars === 1 ? 'bar' : 'bars'}</small>`;
    $('#chip-metro').setAttribute('aria-pressed', String(settings.metro));
    $('#chip-loop').setAttribute('aria-pressed', String(settings.loop));
    const qOn = take.q.grid !== 'off' && take.q.strength > 0;
    $('#q-label').textContent = qOn ? take.q.grid + (T.GRIDS[take.q.grid].swing && take.q.swing > 0.505 ? ' sw' : '') : 'Q off';
    $('#btn-q').classList.toggle('on', qOn);
    if (TR.state === 'idle') $('#counter').textContent = take.notes.length ? `${take.notes.length} ${take.notes.length === 1 ? 'note' : 'notes'}` : '';
    $('#btn-rec .tlabel').textContent = TR.state === 'idle' ? 'Rec' : 'Stop';
  }
  function renderAll() {
    renderHeader();
    buildKeyboard();
    sizeRoll();
  }

  $('#btn-rec').onclick = () => {
    if (TR.state === 'idle') startTransport('rec');
    else stopTransport();
  };
  $('#btn-play').onclick = () => {
    if (TR.state === 'idle') startTransport('play');
    else stopTransport();
  };
  $('#chip-metro').onclick = () => { settings.metro = !settings.metro; saveSettings(); renderHeader(); };
  $('#chip-loop').onclick = () => {
    settings.loop = !settings.loop; saveSettings(); renderHeader();
    toast(settings.loop ? 'Loop on: recording layers every pass' : 'Loop off');
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

  function refreshSheet(id) {
    if (id === '#sheet-sound') {
      $$('#preset-grid .preset').forEach(b => b.classList.toggle('on', b.dataset.v === take.preset));
      segSet('#seg-layout', settings.layout);
      segSet('#seg-vel', settings.vel);
    }
    if (id === '#sheet-setup') {
      $('#bpm-val').textContent = take.bpm;
      $('#bpm-range').value = take.bpm;
      $('#meter-val').textContent = `${take.num}/${take.den}`;
      segSet('#seg-den', take.den);
      segSet('#seg-bars', take.bars);
      segSet('#seg-countin', settings.countIn);
      segSet('#seg-overdub', settings.overdub);
      $('#click-vol').value = settings.clickVol;
      $('#latency').value = settings.latencyMs;
      $('#latency-val').textContent = settings.latencyMs + ' ms';
    }
    if (id === '#sheet-q') {
      $$('#grid-pick button').forEach(b => b.classList.toggle('on', b.dataset.v === take.q.grid));
      const sw = T.GRIDS[take.q.grid] && T.GRIDS[take.q.grid].swing;
      $('#row-swing').style.opacity = sw ? 1 : 0.35;
      $('#swing').disabled = !sw;
      $('#swing').value = Math.round(take.q.swing * 100);
      $('#swing-val').textContent = Math.round(take.q.swing * 100) + '%';
      $('#strength').value = Math.round(take.q.strength * 100);
      $('#strength-val').textContent = Math.round(take.q.strength * 100) + '%';
      segSet('#seg-ends', take.q.ends ? 1 : 0);
    }
    if (id === '#sheet-take') {
      $('#take-rename').value = take.name;
      const sel = $('#take-project');
      sel.innerHTML = '';
      for (const p of sortedProjects()) sel.add(new Option(p.name, p.id, false, p.id === take.projectId));
      const an = T.analyze(take.notes, take.num, take.den);
      const est = T.estimateKey(an);
      $('#take-key').innerHTML = est
        ? `Sounds like <b>${est.label}</b>${est.confident ? '' : ' (low confidence)'} · ${Math.round(est.match.fit * 100)}% of notes in that scale`
        : 'No notes yet.';
      $('#act-undo').disabled = !undoStack.length;
      $('#act-export').disabled = !take.notes.length;
    }
  }

  // --- sound sheet
  $('#btn-sound').onclick = () => openSheet('#sheet-sound');
  const pg = $('#preset-grid');
  for (const k of A.PRESET_ORDER) {
    const b = document.createElement('button');
    b.className = 'preset'; b.dataset.v = k; b.textContent = A.PRESETS[k].label;
    b.onclick = () => {
      A.unlock();
      const wasDrums = isDrums();
      settings.preset = k; saveSettings();
      if (wasDrums !== !!A.PRESETS[k].drums && take.notes.length) {
        // Drum notes and melody notes mean different things: start fresh.
        take = newTake(settings.projectId);
        undoStack.length = 0;
        toast(A.PRESETS[k].drums ? 'New drum take' : 'New take');
      } else {
        take.preset = k;
        persistTake();
      }
      refreshSheet('#sheet-sound');
      renderAll();
      // audition
      if (isDrums()) A.playNote(k, 38, 100, A.ctx.currentTime + 0.01, 0.2);
      else A.playNote(k, 12 * (octave() + 1) + 7, 100, A.ctx.currentTime + 0.01, 0.4);
    };
    pg.appendChild(b);
  }
  segOn('#seg-layout', v => { settings.layout = v; saveSettings(); buildKeyboard(); });
  segOn('#seg-vel', v => { settings.vel = v; saveSettings(); });

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
    if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setTempo(60000 / iv);
    }
  };
  function setMeter(num, den) {
    take.num = Math.max(1, Math.min(15, num)); take.den = den;
    settings.num = take.num; settings.den = den; saveSettings(); persistTake();
    refreshSheet('#sheet-setup'); renderHeader(); sizeRoll();
  }
  $('#num-down').onclick = () => setMeter(take.num - 1, take.den);
  $('#num-up').onclick = () => setMeter(take.num + 1, take.den);
  segOn('#seg-den', v => setMeter(take.num, +v));
  segOn('#seg-bars', v => {
    take.bars = +v; settings.bars = +v; saveSettings(); persistTake(); renderHeader(); sizeRoll();
  });
  segOn('#seg-countin', v => { settings.countIn = +v; saveSettings(); });
  segOn('#seg-overdub', v => { settings.overdub = v; saveSettings(); });
  $('#click-vol').oninput = e => { settings.clickVol = +e.target.value; A.setClickVolume(settings.clickVol); saveSettings(); };
  $('#latency').oninput = e => { settings.latencyMs = +e.target.value; $('#latency-val').textContent = settings.latencyMs + ' ms'; saveSettings(); };

  // --- quantize sheet
  $('#btn-q').onclick = () => openSheet('#sheet-q');
  const gp = $('#grid-pick');
  for (const k of T.GRID_ORDER) {
    const b = document.createElement('button');
    b.dataset.v = k; b.textContent = T.GRIDS[k].label;
    b.onclick = () => { take.q.grid = k; qChanged(); };
    gp.appendChild(b);
  }
  $('#swing').oninput = e => { take.q.swing = +e.target.value / 100; qChanged(); };
  $('#strength').oninput = e => { take.q.strength = +e.target.value / 100; qChanged(); };
  segOn('#seg-ends', v => { take.q.ends = v === '1'; qChanged(); });
  function qChanged() {
    settings.q = { ...take.q }; saveSettings(); persistTake();
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
  $('#act-export').onclick = () => exportTakes([take], take.name);
  $('#act-undo').onclick = () => {
    if (!undoStack.length) return;
    take.notes = undoStack.pop(); persistTake(); refreshSheet('#sheet-take'); renderAll(); toast('Undone');
  };
  $('#act-dup').onclick = () => {
    const copy = JSON.parse(JSON.stringify(take));
    copy.id = 't' + uid(); copy.name = take.name + ' copy'; copy.created = Date.now();
    take = copy; persistTake(take, true); closeSheet(); renderAll(); toast('Duplicated');
  };
  $('#act-new').onclick = () => {
    take = newTake(settings.projectId); undoStack.length = 0; closeSheet(); renderAll();
  };
  // Two-step delete (dialogs are not available everywhere this runs).
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
    closeSheet(); renderAll(); toast('Deleted ' + gone.name);
  });

  // =================================================================
  // Export
  // =================================================================
  function safeName(s) { return (s || 'take').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'take'; }
  function takeMidi(t) {
    const notes = quantized(t);
    const an = T.analyze(notes, t.num, t.den);
    const est = T.estimateKey(an);
    const drums = !!A.PRESETS[t.preset].drums;
    return M.writeMidi({
      name: t.name, bpm: t.bpm, num: t.num, den: t.den, notes,
      channel: drums ? 9 : 0, program: drums ? null : A.PRESETS[t.preset].gm,
      keySig: est && !drums ? T.keySignature(est.tonic, est.mode) : null,
      lengthQ: t.bars * T.barQuarters(t.num, t.den),
    });
  }
  function takeFileName(t) { return `${safeName(t.name)} ${t.bpm}bpm.mid`; }

  async function exportTakes(list, label) {
    list = list.filter(t => t.notes.length);
    if (!list.length) { toast('Nothing to export yet'); return; }
    const files = list.map(t => ({ name: takeFileName(t), data: takeMidi(t), mime: 'audio/midi' }));
    await deliver(files, safeName(label));
  }

  // Hand files to the person. Order: claude.ai download prompt (which only
  // takes certain types, so MIDI travels in a .zip), share sheet on phones,
  // then a plain browser download.
  async function deliver(files, baseName, kind) {
    const inClaude = window.claude && typeof window.claude.use === 'function';
    if (inClaude) {
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
      const notes = quantized(t);
      const drums = !!A.PRESETS[t.preset].drums;
      const an = drums ? null : T.analyze(notes, t.num, t.den);
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

  // Fill static filter selects once.
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
    const keyTxt = A.PRESETS[t.preset].drums ? 'Drums' : est ? est.label + (est.confident ? '' : '?') : '—';
    const date = new Date(t.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    b.innerHTML = `<span class="name"></span><span class="side"></span><span class="meta"></span>`;
    b.querySelector('.name').textContent = t.name;
    b.querySelector('.meta').textContent = `${t.bpm} BPM · ${t.num}/${t.den} · ${keyTxt} · ${A.PRESETS[t.preset].label}` + (lib.tab === 'all' && p ? ' · ' + p.name : '');
    const side = b.querySelector('.side');
    if (extra) {
      side.innerHTML = `<span class="score">${Math.round(extra.score * 100)}</span>match`;
      const why = document.createElement('span');
      why.className = 'why';
      const tonicName = T.NOTE_NAMES[extra.tonic];
      const outs = extra.outside.slice(0, 4).map(o => T.spellOutside(o.pc, extra.tonic, extra.mode) + ' ' + Math.round(o.share * 100) + '%').join(', ');
      why.innerHTML = `<b>${Math.round(extra.fit * 100)}%</b> in key · center ${tonicName} ${extra.centerRel > 0.8 ? 'likely' : extra.centerRel > 0.3 ? 'possible' : 'unlikely'}` +
        (extra.outside.length ? ` · outside: ${outs}` : ' · nothing outside');
      b.appendChild(why);
    } else {
      side.textContent = date;
    }
    b.onclick = () => loadTake(t.id);
    return b;
  }

  function loadTake(id) {
    const t = takes.get(id);
    if (!t) return;
    take = t;
    undoStack.length = 0;
    Object.assign(settings, { takeId: t.id, projectId: t.projectId, preset: t.preset, bpm: t.bpm, num: t.num, den: t.den, bars: t.bars, q: { ...t.q } });
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
    let rows = all.filter(t => {
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
    // meter options from data
    const meters = [...new Set([...takes.values()].map(t => `${t.num}/${t.den}`))].sort();
    const fm = $('#f-meter'), cur = fm.value;
    fm.innerHTML = '<option value="">Any</option>';
    meters.forEach(m => fm.add(new Option(m, m, false, m === cur)));
    $('#store-note').textContent = store ? {
      claude: 'Saved to your Claude account (private to you).',
      idb: 'Saved on this device. Back up now and then.',
      memory: 'Storage is blocked here: takes vanish on reload. Back up!',
    }[store.kind] : 'Loading…';

    const showSearch = lib.tab === 'all' || !!lib.projectId;
    $('#lib-search').hidden = !showSearch;

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
        if (!take.notes.length) take.projectId = p.id;
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
    const data = JSON.stringify({ app: 'noodle', version: 1, exported: new Date().toISOString(), docs });
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
        (d.kind === 'take' ? takes : projects).set(d.id, d);
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
    // Usable instantly; the saved library arrives a moment later.
    const p0 = newProject('Ideas');
    projects.set(p0.id, p0);
    settings.projectId = settings.projectId || p0.id;
    take = newTake(settings.projectId);
    renderAll();
    document.addEventListener('pointerdown', function first() {
      A.unlock(); A.setClickVolume(settings.clickVol);
      document.removeEventListener('pointerdown', first);
    });

    window.NoodleStore.openStore().then(async s => {
      store = s;
      const docs = await s.loadAll();
      const draft = take.notes.length ? take : null; // recorded before the store answered
      projects.clear(); takes.clear();
      for (const d of docs) {
        if (d.kind === 'project') projects.set(d.id, d);
        else if (d.kind === 'take' && Array.isArray(d.notes)) takes.set(d.id, d);
      }
      if (!projects.size) persistProject(p0);
      if (!projects.has(settings.projectId)) settings.projectId = sortedProjects()[0].id;
      if (draft) { draft.projectId = projects.has(draft.projectId) ? draft.projectId : settings.projectId; take = draft; persistTake(draft, true); }
      else if (TR.state === 'idle') {
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
    get transport() { return TR; }, get store() { return store; }, settings: () => settings,
    takeMidi, quantized,
  };
  boot();
})();
