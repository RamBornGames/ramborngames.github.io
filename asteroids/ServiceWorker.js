const version = encodeURIComponent("2026.11.28.4-daed1381");
const cachePrefix = "unity-webgl-" + self.registration.scope + "-";
const legacyCachePrefix = "Ramsey Fireborn Games Studio-Asteroid Fishing-";
const cacheName = cachePrefix + version;
const buildPathPrefix = new URL("Build/", self.registration.scope).pathname;
const deferredPathPrefix = new URL("StreamingAssets/Deferred/", self.registration.scope).pathname;
const versionPath = new URL("version.json", self.registration.scope).pathname;
const contentToCache = [
  "index.html",
  "TemplateData/style.css?v=" + version,
  "TemplateData/player-saves.css?v=" + version,
  "TemplateData/player-saves.js?v=" + version,
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

  // The release check must reach the network. Do not intercept Unity Build payloads either.
  // GitHub Pages serves raw Wasm and Unity owns data caching. Duplicating these
  // paths exhausts Safari's startup resources on larger mobile builds.
  // Versioned optional bundles also use the HTTP cache without a second Cache API copy.
  const requestUrl = new URL(event.request.url);
  // Cross-origin APIs own their cache policy, including the live arcade totals.
  if (requestUrl.origin !== self.location.origin ||
      (requestUrl.pathname === versionPath || requestUrl.pathname.startsWith(buildPathPrefix)
        || requestUrl.pathname.startsWith(deferredPathPrefix))) return;

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
