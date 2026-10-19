const CACHE = "museum-pos-shell-v1";
const SHELL = ["/", "/manifest.json"];
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => { try { await cache.add(new Request(url, { cache: "reload" })); } catch {} }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("museum-pos-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try { const response = await fetch(request); if (response.ok) cache.put(request, response.clone()); return response; }
      catch { return new Response("Offline asset unavailable", { status: 503 }); }
    })());
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try { const response = await fetch(request); if (response.ok) cache.put("/", response.clone()); return response; }
      catch { return (await cache.match(request)) || (await cache.match("/")) || new Response("Museum POS is offline. Open the app online once, then retry.", { status: 503 }); }
    })());
  }
});
