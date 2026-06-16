const CACHE = "current-v1";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls — they must always hit the network.
  if (url.pathname.startsWith("/api/")) return;
  // App shell: cache-first, fall back to network.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
