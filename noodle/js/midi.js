/* Noodle — Standard MIDI File writer and a tiny store-only ZIP writer. */
(function (root) {
  'use strict';

  const PPQ = 480;

  function vlq(n) {
    n = Math.max(0, Math.round(n));
    const bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    return bytes;
  }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function text(s) { return Array.from(new TextEncoder().encode(s)); }

  function trackChunk(ev, endTick) {
    ev.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const last = ev.length ? ev[ev.length - 1].tick : 0;
    const end = Math.max(Math.round(endTick || 0), last);
    const out = [];
    let prev = 0;
    for (const e of ev) { out.push(...vlq(e.tick - prev), ...e.bytes); prev = e.tick; }
    out.push(...vlq(end - prev), 0xff, 0x2f, 0x00);
    return [...text('MTrk'), ...u32(out.length), ...out];
  }
  const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes];

  /**
   * Type-1 Standard MIDI File.
   * song: {name, bpm, num, den, keySig: {sf, mi} | null, lengthQ,
   *        tracks: [{name, notes: [{p,t,d,v}] (quarters), channel, program}]}
   * BPM counts the denominator unit; MIDI tempo is per quarter note.
   */
  function writeSong(song) {
    const den = song.den || 4;
    const usPerQuarter = Math.round(60000000 / (song.bpm * (4 / den)));
    const endTick = (song.lengthQ || 0) * PPQ;
    const conductor = [
      { tick: 0, order: 0, bytes: meta(0x03, text(song.name || 'Noodle')) },
      { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255] },
      { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, song.num || 4, Math.log2(den), 24, 8] },
    ];
    if (song.keySig) conductor.push({ tick: 0, order: 0, bytes: [0xff, 0x59, 0x02, song.keySig.sf & 255, song.keySig.mi] });
    const chunks = [trackChunk(conductor, endTick)];
    for (const tr of song.tracks) {
      const ch = tr.channel || 0, ev = [];
      ev.push({ tick: 0, order: 0, bytes: meta(0x03, text(tr.name || 'Track')) });
      if (tr.program != null) ev.push({ tick: 0, order: 1, bytes: [0xc0 | ch, tr.program & 127] });
      for (const n of tr.notes) {
        const on = Math.max(0, Math.round(n.t * PPQ));
        const off = Math.max(on + 1, Math.round((n.t + n.d) * PPQ));
        const v = Math.max(1, Math.min(127, Math.round(n.v || 100)));
        ev.push({ tick: on, order: 3, bytes: [0x90 | ch, n.p & 127, v] });
        ev.push({ tick: off, order: 2, bytes: [0x80 | ch, n.p & 127, 0] }); // offs before ons on a tick
      }
      chunks.push(trackChunk(ev, endTick));
    }
    const head = [...text('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
    return new Uint8Array([...head, ...chunks.flat()]);
  }

  // Single-track convenience wrapper.
  function writeMidi(o) {
    return writeSong({ ...o, tracks: [{ name: o.name, notes: o.notes, channel: o.channel, program: o.program }] });
  }

  // ---- ZIP (store, no compression) ----
  let CRC_TABLE = null;
  function crc32(buf) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const le16 = n => [n & 255, (n >>> 8) & 255];
  const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

  // files: [{name, data: Uint8Array}] -> Uint8Array
  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    const used = new Set();
    for (const f of files) {
      let name = f.name, i = 2;
      while (used.has(name)) name = f.name.replace(/(\.\w+)?$/, ` (${i++})$1`);
      used.add(name);
      const nameB = new TextEncoder().encode(name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = [
        ...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21),
        ...le32(crc), ...le32(size), ...le32(size), ...le16(nameB.length), ...le16(0),
      ];
      parts.push(new Uint8Array(local), nameB, f.data);
      central.push(new Uint8Array([
        ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21),
        ...le32(crc), ...le32(size), ...le32(size), ...le16(nameB.length), ...le16(0), ...le16(0),
        ...le16(0), ...le16(0), ...le32(0), ...le32(offset),
      ]), nameB);
      offset += local.length + nameB.length + size;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new Uint8Array([
      ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length),
      ...le32(cdSize), ...le32(offset), ...le16(0),
    ]);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  const api = { PPQ, writeMidi, writeSong, zip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NoodleMidi = api;
})(typeof window !== 'undefined' ? window : globalThis);
