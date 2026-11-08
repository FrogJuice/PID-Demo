/* Noodle — persistence. Every record is one JSON doc with {id, kind}.
 * Backends share one tiny interface: loadAll(), put(doc), remove(id).
 *  - ClaudeStore: when running as a claude.ai Artifact with the `db`
 *    capability, docs live in the viewer's private subtree (synced to
 *    their account, private even from anyone the page is shared with).
 *  - IdbStore: IndexedDB in the browser (installed PWA).
 *  - MemoryStore: last resort; nothing survives a reload.
 */
(function (root) {
  'use strict';

  function MemoryStore() {
    const m = new Map();
    return {
      kind: 'memory', durable: false,
      async loadAll() { return [...m.values()].map(d => JSON.parse(JSON.stringify(d))); },
      async put(doc) { m.set(doc.id, JSON.parse(JSON.stringify(doc))); },
      async remove(id) { m.delete(id); },
    };
  }

  function IdbStore() {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const req = indexedDB.open('noodle', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(db => new Promise((res, rej) => {
        const t = db.transaction('docs', mode);
        const out = fn(t.objectStore('docs'));
        t.oncomplete = () => res(out && out.result);
        t.onerror = () => rej(t.error);
      }));
    }
    return {
      kind: 'idb', durable: true,
      async loadAll() { return (await tx('readonly', s => s.getAll())) || []; },
      put(doc) { return tx('readwrite', s => s.put(doc)); },
      remove(id) { return tx('readwrite', s => s.delete(id)); },
    };
  }

  function ClaudeStore(db, uid) {
    const col = db.collection('data/users/' + uid);
    const safe = id => id.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
    async function retry(fn) {
      try { return await fn(); } catch (e) {
        if (e && e.code === 'unavailable') { await new Promise(r => setTimeout(r, 400 + Math.random() * 600)); return fn(); }
        throw e;
      }
    }
    return {
      kind: 'claude', durable: true,
      async loadAll() {
        const snap = await retry(() => col.limit(1000).get());
        return snap.docs.filter(d => d.exists).map(d => JSON.parse(JSON.stringify(d.data())));
      },
      put(doc) { return retry(() => col.doc(safe(doc.id)).set(JSON.parse(JSON.stringify(doc)))); },
      remove(id) { return retry(() => col.doc(safe(id)).delete()); },
    };
  }

  // Pick the best backend available in this view.
  async function openStore() {
    const c = root.claude;
    if (c && typeof c.use === 'function') {
      try {
        const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
        const uid = user ? await user.id() : null;
        if (db && uid) {
          const s = ClaudeStore(db, uid);
          await s.loadAll(); // probe: fails fast if this viewer cannot read
          return s;
        }
      } catch (e) { console.warn('claude db unavailable, falling back', e); }
    }
    try {
      if (root.indexedDB) {
        const s = IdbStore();
        await s.loadAll();
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* optional */ }
        return s;
      }
    } catch (e) { console.warn('IndexedDB unavailable', e); }
    return MemoryStore();
  }

  root.NoodleStore = { openStore, MemoryStore, IdbStore, ClaudeStore };
})(window);
