// Offline cache. App files: serve from cache, refresh in the background.
// Covers: cache on first view. Bump VERSION when the file list changes.
const VERSION = "antilibrary-v1";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "css/fonts.css",
  "js/main.js", "js/store.js", "js/backup.js", "js/domain.js", "js/keys.js", "js/ids.js", "js/csv.js", "js/format.js", "js/migrations.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "fonts/source-serif-4-normal-latin.woff2", "fonts/source-serif-4-italic-latin.woff2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== "covers").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  } else if (/gr-assets\.com|goodreads\.com|openlibrary\.org/.test(url.hostname) && req.destination === "image") {
    e.respondWith(caches.open("covers").then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    }));
  }
});
