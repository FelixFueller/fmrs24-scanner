// Kleine IndexedDB-Hülle: "pages" = Seiten des aktuellen Scans, "docs" = fertige Dokumente / Warteschlange.
const DB_NAME = 'fmrs-scanner';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
export const put = (store, obj) => tx(store, 'readwrite', s => s.put(obj));
export const get = (store, id) => tx(store, 'readonly', s => s.get(id));
export const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
export const all = (store) => tx(store, 'readonly', s => s.getAll());
export const clear = (store) => tx(store, 'readwrite', s => s.clear());
