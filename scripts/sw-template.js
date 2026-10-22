// Service worker for the web version: makes the installed app work offline.
// Generated into dist/sw.js at build time with the list of files to cache.
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `pdf-editor-${VERSION}`;
const url = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map(url)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("pdf-editor-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === "navigate") {
        // Online: always get the latest app. Offline: use the cached copy.
        try {
          return await fetch(req);
        } catch {
          return (await cache.match(url("index.html"), { ignoreVary: true })) ?? Response.error();
        }
      }
      const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })(),
  );
});
