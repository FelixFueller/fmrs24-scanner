// Offline-Start: App-Dateien zwischenspeichern. Dropbox-Aufrufe gehen nie über den Cache.
const VERSION = 'fmrs-scan-1.1.0';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'scan.js', 'pdf.js', 'store.js', 'dropbox.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // Netz zuerst (damit Updates sofort da sind), ohne Netz aus dem Cache
  if (u.pathname.endsWith('/version.json')) return; // immer frisch vom Server
  // Netz zuerst und am Browser-Cache vorbei nachfragen, damit neue Versionen sofort ankommen
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
