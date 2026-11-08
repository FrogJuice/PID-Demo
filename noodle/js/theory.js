/* Noodle — music theory: time math, quantize, key analysis.
 * Pure functions, no DOM. Loaded as a classic script in the browser
 * (attaches to window.NoodleTheory) and via require() in node tests.
 *
 * Time unit everywhere: quarter notes ("q"), measured from bar 1 beat 1.
 * A note is {p, t, d, v}: MIDI pitch, start (q), duration (q), velocity 1-127.
 */
(function (root) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // ---------- meter / tempo ----------
  // BPM counts the denominator unit (so 6/8 @ 120 = 120 eighth notes per minute).
  function quartersPerBeat(den) { return 4 / den; }
  function barQuarters(num, den) { return num * quartersPerBeat(den); }
  function secPerQuarter(bpm, den) { return 60 / bpm / quartersPerBeat(den); }

  // ---------- quantize ----------
  // cell = grid step in quarters. `swing` grids pair cells: the off-cell lands at
  // swing * pairLength (0.5 = straight, 0.667 = triplet feel, 0.75 = dotted).
  const GRIDS = {
    'off':   { label: 'Off',   cell: 0 },
    '1/4':   { label: '1/4',   cell: 1 },
    '1/8':   { label: '1/8',   cell: 0.5,   swing: true },
    '1/16':  { label: '1/16',  cell: 0.25,  swing: true },
    '1/32':  { label: '1/32',  cell: 0.125 },
    '1/4T':  { label: '1/4T',  cell: 2 / 3 },
    '1/8T':  { label: '1/8T',  cell: 1 / 3 },
    '1/16T': { label: '1/16T', cell: 1 / 6 },
  };
  const GRID_ORDER = ['off', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T'];

  // Nearest grid point to t. The grid restarts at every barline so odd meters
  // (7/8, 5/4) and triplets stay aligned to the bar.
  function snap(t, gridKey, swing, barLen) {
    const g = GRIDS[gridKey];
    if (!g || !g.cell) return t;
    const sw = g.swing ? clamp(swing == null ? 0.5 : swing, 0.5, 0.8) : 0.5;
    const pair = g.swing ? g.cell * 2 : g.cell;
    const offsets = g.swing ? [0, pair * sw] : [0];
    const barStart = Math.floor(t / barLen + 1e-9) * barLen;
    const local = t - barStart;
    let best = barStart + barLen; // next barline is always a candidate
    let bestDist = Math.abs(best - t);
    const k0 = Math.floor(local / pair);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      if (k < 0) continue;
      for (const off of offsets) {
        const cand = barStart + k * pair + off;
        if (cand > barStart + barLen + 1e-9) continue;
        const dist = Math.abs(cand - t);
        if (dist < bestDist - 1e-12) { best = cand; bestDist = dist; }
      }
    }
    return best;
  }

  // q = {grid, swing (0.5-0.8), strength (0-1), ends (bool)}
  // Returns new note objects; never mutates the input. Notes that snap onto the
  // loop end wrap to the loop start (a note played just before the downbeat
  // belongs to beat 1).
  function quantizeNotes(notes, q, num, den, loopLen) {
    const barLen = barQuarters(num, den);
    const g = GRIDS[q && q.grid];
    if (!g || !g.cell || !(q.strength > 0)) return notes.map(n => ({ ...n }));
    const s = clamp(q.strength, 0, 1);
    return notes.map(n => {
      let t = n.t + s * (snap(n.t, q.grid, q.swing, barLen) - n.t);
      let d = n.d;
      if (q.ends) {
        const end = n.t + n.d;
        const qEnd = end + s * (snap(end, q.grid, q.swing, barLen) - end);
        d = Math.max(qEnd - t, g.cell * 0.5);
      }
      if (loopLen && t >= loopLen - 1e-9) t -= loopLen;
      if (t < 0) t = 0;
      if (loopLen) d = Math.min(d, Math.max(loopLen - t, 0.03));
      return { ...n, t, d };
    });
  }

  // ---------- scales ----------
  const MODES = {
    major:            { label: 'Major',             pcs: [0, 2, 4, 5, 7, 9, 11],  prior: 0.03 },
    minor:            { label: 'Minor',             pcs: [0, 2, 3, 5, 7, 8, 10],  prior: 0.03 },
    harmonicMinor:    { label: 'Harmonic minor',    pcs: [0, 2, 3, 5, 7, 8, 11],  prior: 0.015 },
    melodicMinor:     { label: 'Melodic minor',     pcs: [0, 2, 3, 5, 7, 9, 11],  prior: 0.01 },
    dorian:           { label: 'Dorian',            pcs: [0, 2, 3, 5, 7, 9, 10],  prior: 0.015 },
    phrygian:         { label: 'Phrygian',          pcs: [0, 1, 3, 5, 7, 8, 10],  prior: 0.01 },
    lydian:           { label: 'Lydian',            pcs: [0, 2, 4, 6, 7, 9, 11],  prior: 0.01 },
    mixolydian:       { label: 'Mixolydian',        pcs: [0, 2, 4, 5, 7, 9, 10],  prior: 0.015 },
    locrian:          { label: 'Locrian',           pcs: [0, 1, 3, 5, 6, 8, 10],  prior: 0.0 },
    phrygianDominant: { label: 'Phrygian dominant', pcs: [0, 1, 4, 5, 7, 8, 10],  prior: 0.005 },
    lydianDominant:   { label: 'Lydian dominant',   pcs: [0, 2, 4, 6, 7, 9, 10],  prior: 0.0 },
    harmonicMajor:    { label: 'Harmonic major',    pcs: [0, 2, 4, 5, 7, 8, 11],  prior: 0.0 },
    doubleHarmonic:   { label: 'Double harmonic',   pcs: [0, 1, 4, 5, 7, 8, 11],  prior: 0.0 },
    hungarianMinor:   { label: 'Hungarian minor',   pcs: [0, 2, 3, 6, 7, 8, 11],  prior: 0.0 },
    majorPentatonic:  { label: 'Major pentatonic',  pcs: [0, 2, 4, 7, 9],         prior: -0.01 },
    minorPentatonic:  { label: 'Minor pentatonic',  pcs: [0, 3, 5, 7, 10],        prior: -0.01 },
    blues:            { label: 'Blues',             pcs: [0, 3, 5, 6, 7, 10],     prior: -0.01 },
    wholeTone:        { label: 'Whole tone',        pcs: [0, 2, 4, 6, 8, 10],     prior: -0.02 },
  };
  const MODE_ORDER = Object.keys(MODES);

  // ---------- key analysis ----------
  // Krumhansl–Kessler probe-tone profiles (major / minor), index 0 = tonic.
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  // Weights for the similarity score. Kept here so they are easy to tune.
  const W = {
    fit: 0.5,        // share of the playing (count + capped duration) inside the scale
    center: 0.3,     // how likely the queried tonic is the tonal center
    spread: 0.2,     // penalty for how MANY different outside notes are used
    spreadFull: 4,   // this many distinct outside notes = full spread penalty
    minorNote: 0.04, // an outside note under this share counts fractionally
  };

  function normalize(a) {
    const s = a.reduce((x, y) => x + y, 0);
    return s > 0 ? a.map(x => x / s) : a.map(() => 0);
  }

  function pearson(a, b) {
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  // Everything search needs about a take's pitch content, computed once.
  function analyze(notes, num, den) {
    if (!notes || !notes.length) return null;
    const barLen = barQuarters(num || 4, den || 4);
    const cnt = new Array(12).fill(0);
    const dur = new Array(12).fill(0);
    const strong = new Array(12).fill(0);
    const bass = new Array(12).fill(0);
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    const bassCut = lo + Math.max(2, (hi - lo) / 3);
    let first = notes[0], last = notes[0];
    for (const n of notes) {
      const pc = ((n.p % 12) + 12) % 12;
      const d = Math.min(n.d, 2);
      cnt[pc] += 1;
      dur[pc] += d;
      const posInBar = ((n.t % barLen) + barLen) % barLen;
      const beatLen = quartersPerBeat(den || 4);
      if (posInBar < 0.08 || barLen - posInBar < 0.08) strong[pc] += 2;
      else if (Math.abs(posInBar / beatLen - Math.round(posInBar / beatLen)) * beatLen < 0.06) strong[pc] += 1;
      if (n.p <= bassCut) bass[pc] += d;
      if (n.t < first.t || (n.t === first.t && n.p < first.p)) first = n;
      if (n.t + n.d > last.t + last.d || (n.t + n.d === last.t + last.d && n.p < last.p)) last = n;
    }
    const hist = normalize(cnt).map((c, i) => 0.5 * c + 0.5 * normalize(dur)[i]);
    const strongN = normalize(strong);
    const bassN = normalize(bass);

    // Tonal-center evidence per pitch class.
    const centerRaw = new Array(12).fill(0);
    for (let tonic = 0; tonic < 12; tonic++) {
      const rot = hist.map((_, i) => hist[(i + tonic) % 12]);
      const r = Math.max(pearson(rot, KK_MAJOR), pearson(rot, KK_MINOR));
      centerRaw[tonic] =
        0.55 * (r + 1) / 2 +
        0.15 * strongN[tonic] +
        0.10 * bassN[tonic] +
        0.15 * (last.p % 12 === tonic ? 1 : 0) +
        0.05 * (first.p % 12 === tonic ? 1 : 0);
    }
    // Softmax -> a probability-like distribution over the 12 tonics.
    const T = 0.04;
    const mx = Math.max(...centerRaw);
    const center = normalize(centerRaw.map(x => Math.exp((x - mx) / T)));
    const best = center.indexOf(Math.max(...center));
    return { hist, center, centerBest: best, noteCount: notes.length };
  }

  // Similarity of an analyzed take to (tonic, mode). Returns score 0-1 plus
  // the parts so the UI can explain the ranking.
  function keyMatch(an, tonic, modeKey) {
    if (!an) return null;
    const mode = MODES[modeKey];
    const inScale = new Array(12).fill(false);
    for (const i of mode.pcs) inScale[(tonic + i) % 12] = true;
    let fit = 0, spreadCount = 0;
    const outside = [];
    for (let pc = 0; pc < 12; pc++) {
      const h = an.hist[pc];
      if (inScale[pc]) { fit += h; continue; }
      if (h <= 0) continue;
      spreadCount += Math.min(1, h / W.minorNote);
      outside.push({ pc, share: h });
    }
    outside.sort((a, b) => b.share - a.share);
    const centerRel = an.center[tonic] / Math.max(...an.center);
    const spread = Math.min(1, spreadCount / W.spreadFull);
    const score = W.fit * fit + W.center * centerRel + W.spread * (1 - spread);
    return { score, fit, centerRel, spread, outside };
  }

  // Best-guess key label for a take.
  function estimateKey(an) {
    if (!an) return null;
    let best = null;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const m of MODE_ORDER) {
        const k = keyMatch(an, tonic, m);
        const s = k.score + MODES[m].prior;
        if (!best || s > best.s) best = { s, tonic, mode: m, match: k };
      }
    }
    // Confidence: how far the winner sits above the best rival with a
    // DIFFERENT tonic (same-tonic rivals are just mode flavours).
    let rival = 0;
    for (let tonic = 0; tonic < 12; tonic++) {
      if (tonic === best.tonic) continue;
      for (const m of MODE_ORDER) rival = Math.max(rival, keyMatch(an, tonic, m).score + MODES[m].prior);
    }
    best.confident = best.s - rival > 0.08 && an.noteCount >= 6;
    best.label = NOTE_NAMES[best.tonic] + ' ' + MODES[best.mode].label.toLowerCase();
    return best;
  }

  // MIDI key-signature meta values {sf, mi} for a tonic + mode.
  const SF_OF_MAJOR = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  const DIATONIC_OFFSET = { major: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, locrian: 11 };
  function keySignature(tonic, modeKey) {
    if (modeKey in DIATONIC_OFFSET) {
      const parent = ((tonic - DIATONIC_OFFSET[modeKey]) % 12 + 12) % 12;
      return { sf: SF_OF_MAJOR[parent], mi: modeKey === 'minor' ? 1 : 0 };
    }
    const pcs = MODES[modeKey].pcs;
    if (pcs.includes(3) && !pcs.includes(4)) return { sf: SF_OF_MAJOR[(tonic + 3) % 12], mi: 1 };
    return { sf: SF_OF_MAJOR[tonic], mi: 0 };
  }

  // Name an outside note relative to a key: a raised scale degree gets a sharp
  // (G# in A minor), anything else a flat (Bb in C major).
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  function spellOutside(pc, tonic, modeKey) {
    const rel = ((pc - tonic) % 12 + 12) % 12;
    const pcs = MODES[modeKey].pcs;
    const below = pcs.includes((rel + 11) % 12), above = pcs.includes((rel + 1) % 12);
    if (below && !above) return SHARPS[pc];
    if (above && !below) return FLATS[pc];
    return rel === 11 || rel === 6 ? SHARPS[pc] : FLATS[pc]; // leading tone, #4
  }

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  const api = {
    spellOutside,
    NOTE_NAMES, GRIDS, GRID_ORDER, MODES, MODE_ORDER, W,
    quartersPerBeat, barQuarters, secPerQuarter,
    snap, quantizeNotes, analyze, keyMatch, estimateKey, keySignature, clamp,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NoodleTheory = api;
})(typeof window !== 'undefined' ? window : globalThis);
