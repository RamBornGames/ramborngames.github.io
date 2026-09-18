const version = encodeURIComponent("2026.09.18.1-fc4bda24");
const cachePrefix = "unity-webgl-" + self.registration.scope + "-";
const legacyCachePrefix = "Ramsey Fireborn Games Studio-Asteroid Fishing-";
const cacheName = cachePrefix + version;
const contentToCache = [
  "index.html",
  "Build/2026.09.18_build1_asteroidfishing.loader.js?v=" + version,
  "Build/2026.09.18_build1_asteroidfishing.framework.js.unityweb?v=" + version,
  "Build/2026.09.18_build1_asteroidfishing.data.unityweb?v=" + version,
  "Build/2026.09.18_build1_asteroidfishing.wasm.unityweb?v=" + version,
  "TemplateData/style.css?v=" + version,
  "manifest.webmanifest?v=" + version,
  "TemplateData/asteroids-favicon-32.png?v=" + version,
  "TemplateData/favicon.ico?v=" + version,
  "TemplateData/asteroids-apple-touch-icon.png?v=" + version,
  "TemplateData/asteroid-icon-192.png",
  "TemplateData/asteroid-icon-192.png?v=" + version,
  "TemplateData/asteroid-icon-512.png?v=" + version
];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(caches.open(cacheName).then(function (cache) {
    return cache.addAll(contentToCache);
  }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(function (name) {
        return name !== cacheName &&
          (name.startsWith(cachePrefix) || name.startsWith(legacyCachePrefix));
      })
      .map(function (name) { return caches.delete(name); }));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith((async function () {
    const cache = await caches.open(cacheName);

    if (event.request.mode === "navigate") {
      try {
        const networkResponse = await fetch(event.request, { cache: "no-store" });
        if (networkResponse.ok) await cache.put(event.request, networkResponse.clone());
        return networkResponse;
      } catch (error) {
        const cachedPage = await cache.match(event.request) || await cache.match("index.html");
        if (cachedPage) return cachedPage;
        throw error;
      }
    }

    const cachedResponse = await cache.match(event.request);
    if (cachedResponse) return cachedResponse;

    const networkResponse = await fetch(event.request);
    if (networkResponse.ok) await cache.put(event.request, networkResponse.clone());
    return networkResponse;
  })());
});
