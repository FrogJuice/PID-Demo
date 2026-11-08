// Run: node --test noodle/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/theory.js');
const M = require('../js/midi.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Build a melody from [pitch, durationQ] pairs, laid end to end.
function seq(pairs, start = 0) {
  let t = start;
  return pairs.map(([p, d]) => { const n = { p, t, d, v: 100 }; t += d; return n; });
}

test('meter math', () => {
  assert.equal(T.barQuarters(4, 4), 4);
  assert.equal(T.barQuarters(6, 8), 3);
  assert.equal(T.barQuarters(7, 8), 3.5);
  close(T.secPerQuarter(120, 4), 0.5);
  close(T.secPerQuarter(120, 8), 1); // 120 eighths/min -> quarter = 1 s
});

test('straight grids snap to nearest step', () => {
  close(T.snap(0.13, '1/8', 0.5, 4), 0);
  close(T.snap(0.3, '1/8', 0.5, 4), 0.5);
  close(T.snap(0.3, '1/16', 0.5, 4), 0.25);
  close(T.snap(0.3, '1/8T', 0.5, 4), 1 / 3);
  close(T.snap(3.95, '1/4', 0.5, 4), 4); // rolls to next barline
});

test('swing moves the off-beat', () => {
  close(T.snap(0.62, '1/8', 0.66, 4), 0.66);
  close(T.snap(0.62, '1/8', 0.5, 4), 0.5);
  close(T.snap(0.36, '1/16', 0.66, 4), 0.33);
  close(T.snap(0.9, '1/8', 0.66, 4), 1);
});

test('triplets restart at the barline in odd meters', () => {
  // 7/8 bar = 3.5 q. Bar 2 starts at 3.5; first 1/4T after it is 3.5 + 2/3.
  close(T.snap(4.15, '1/4T', 0.5, 3.5), 3.5 + 2 / 3);
});

test('strength and wrap', () => {
  const notes = [{ p: 60, t: 0.1, d: 0.4, v: 90 }, { p: 62, t: 7.97, d: 0.5, v: 90 }];
  const half = T.quantizeNotes(notes, { grid: '1/8', swing: 0.5, strength: 0.5 }, 4, 4, 8);
  close(half[0].t, 0.05);
  const full = T.quantizeNotes(notes, { grid: '1/8', swing: 0.5, strength: 1 }, 4, 4, 8);
  close(full[0].t, 0);
  close(full[1].t, 0); // snapped onto loop end -> wraps to start
  assert.equal(notes[0].t, 0.1, 'input untouched');
  const off = T.quantizeNotes(notes, { grid: 'off', strength: 1 }, 4, 4, 8);
  close(off[0].t, 0.1);
});

test('quantize ends', () => {
  const [n] = T.quantizeNotes([{ p: 60, t: 0.04, d: 0.42, v: 90 }], { grid: '1/8', swing: 0.5, strength: 1, ends: true }, 4, 4, 8);
  close(n.t, 0); close(n.d, 0.5);
});

// --- key analysis -----------------------------------------------------------
const A = 57, C = 60;
// A harmonic minor with the raised 7th (G#) all over it, ends on A.
const harmonicA = seq([
  [A, 1], [C, .5], [64, .5], [68, 1], [69, 1], [71, .5], [68, .5], [69, 1], [64, 1],
  [65, .5], [64, .5], [62, .5], [68, .5], [69, 2], [72, .5], [71, .5], [68, 1], [A + 12, 2],
]);
// C major melody stuffed with chromatic passing tones, ends on C.
const chromaticC = seq([
  [C, 1], [61, .25], [62, .25], [63, .25], [64, .5], [65, .25], [66, .25], [67, 1], [68, .25], [69, .5],
  [70, .25], [71, .25], [72, 1], [71, .25], [70, .25], [69, .25], [68, .25], [67, 1], [66, .25], [65, .25],
  [64, .5], [63, .25], [62, .25], [61, .25], [C, 2],
]);
const plainCMajor = seq([[C, 1], [62, .5], [64, .5], [65, 1], [67, 1], [69, .5], [67, .5], [65, .5], [64, .5], [62, 1], [C, 2]]);
const naturalA = seq([[A, 1], [59, .5], [C, .5], [62, 1], [64, 1], [65, .5], [64, .5], [62, .5], [C, .5], [59, 1], [A, 2]]);
const relMajorPlain = seq([[C, 1], [64, .5], [67, .5], [72, 1], [67, 1], [65, .5], [64, .5], [62, 1], [C, 2]]);

test('harmonic minor ranks closer to A minor than chromatic relative major', () => {
  const h = T.keyMatch(T.analyze(harmonicA, 4, 4), 9, 'minor');
  const c = T.keyMatch(T.analyze(chromaticC, 4, 4), 9, 'minor');
  assert.ok(h.score > c.score + 0.15, `harm ${h.score.toFixed(3)} vs chrom ${c.score.toFixed(3)}`);
  assert.equal(h.outside[0].pc, 8, 'G# reported as the outside note');
  assert.equal(h.outside.length, 1);
  assert.ok(c.outside.length >= 4);
});

test('natural minor ranks above harmonic minor for an A minor query', () => {
  const n = T.keyMatch(T.analyze(naturalA, 4, 4), 9, 'minor');
  const h = T.keyMatch(T.analyze(harmonicA, 4, 4), 9, 'minor');
  assert.ok(n.score > h.score);
});

test('estimates obvious keys', () => {
  const kc = T.estimateKey(T.analyze(plainCMajor, 4, 4));
  assert.equal(kc.tonic, 0); assert.equal(kc.mode, 'major');
  const ka = T.estimateKey(T.analyze(naturalA, 4, 4));
  assert.equal(ka.tonic, 9); assert.equal(ka.mode, 'minor');
  const kh = T.estimateKey(T.analyze(harmonicA, 4, 4));
  assert.equal(kh.tonic, 9); assert.equal(kh.mode, 'harmonicMinor');
  const kr = T.estimateKey(T.analyze(relMajorPlain, 4, 4));
  assert.equal(kr.tonic, 0);
});

test('key signatures', () => {
  assert.deepEqual(T.keySignature(9, 'minor'), { sf: 0, mi: 1 });
  assert.deepEqual(T.keySignature(2, 'dorian'), { sf: 0, mi: 0 });
  assert.deepEqual(T.keySignature(7, 'major'), { sf: 1, mi: 0 });
  assert.deepEqual(T.keySignature(9, 'harmonicMinor'), { sf: 0, mi: 1 });
  assert.deepEqual(T.keySignature(5, 'major'), { sf: -1, mi: 0 });
});

test('midi writer emits a well-formed type-1 file', () => {
  const bytes = M.writeSong({ name: 'x', bpm: 120, num: 6, den: 8, keySig: { sf: 0, mi: 1 }, lengthQ: 12,
    tracks: [{ name: 'a', notes: harmonicA, channel: 0, program: 0 }, { name: 'd', notes: [{ p: 36, t: 0, d: 0.25, v: 110 }], channel: 9 }] });
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  assert.equal((bytes[8] << 8) | bytes[9], 1, 'format 1');
  assert.equal((bytes[10] << 8) | bytes[11], 3, 'conductor + 2 tracks');
  let o = 14, n = 0;
  while (o < bytes.length) {
    assert.equal(String.fromCharCode(...bytes.slice(o, o + 4)), 'MTrk');
    const len = (bytes[o + 4] << 24) | (bytes[o + 5] << 16) | (bytes[o + 6] << 8) | bytes[o + 7];
    assert.deepEqual(Array.from(bytes.slice(o + 8 + len - 3, o + 8 + len)), [0xff, 0x2f, 0x00]);
    o += 8 + len; n++;
  }
  assert.equal(n, 3);
});

test('quantize leaves hand-placed notes alone and sorts by time', () => {
  const out = T.quantizeNotes([{ p: 64, t: 2.1, d: 0.4, v: 90 }, { p: 60, t: 0.13, d: 0.4, v: 90, lock: true }],
    { grid: '1/4', swing: 0.5, strength: 1 }, 4, 4, 8);
  close(out[0].t, 0.13); close(out[1].t, 2);
  const off = T.quantizeNotes([{ p: 64, t: 2, d: 1, v: 9 }, { p: 60, t: 1, d: 1, v: 9 }], { grid: 'off' }, 4, 4, 8);
  assert.deepEqual(off.map(n => n.t), [1, 2]);
});

test('tension: tonic rests, outside notes are tensest', () => {
  const t = pc => T.tension(pc, 9, 'minor');
  assert.equal(t(9), 0);
  assert.ok(t(4) < t(11), 'fifth calmer than second degree');
  const inScale = [11, 0, 2, 4, 5, 7].map(t), outside = [10, 1, 3, 6, 8].map(t);
  assert.ok(Math.max(...inScale) < Math.min(...outside));
  assert.deepEqual(T.scaleNotes(57, 'minor', 9), [57, 59, 60, 62, 64, 65, 67, 69, 71]);
});

test('zip has correct crc and structure', () => {
  close(M.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = M.zip([{ name: 'a.mid', data: new Uint8Array([1, 2, 3]) }, { name: 'a.mid', data: new Uint8Array([4]) }]);
  assert.equal(z[0], 0x50); assert.equal(z[1], 0x4b);
});
