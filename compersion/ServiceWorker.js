const version = encodeURIComponent("2026.09.02.8-8fffde76");
const cachePrefix = "unity-webgl-" + self.registration.scope + "-";
const legacyCachePrefix = "Ramsey Fireborn Games Studio-Compersion-";
const cacheName = cachePrefix + version;
const contentToCache = [
    "index.html",
    "Build/2026.09.02_build2_compersion2d.loader.js?v=" + version,
    "Build/2026.09.02_build2_compersion2d.framework.js.unityweb?v=" + version,
    "Build/2026.09.02_build2_compersion2d.data.unityweb?v=" + version,
    "Build/2026.09.02_build2_compersion2d.wasm.unityweb?v=" + version,
    "TemplateData/style.css?v=" + version,
    "manifest.webmanifest?v=" + version,
    "TemplateData/compersion-favicon-32.png?v=" + version,
    "TemplateData/favicon.ico?v=" + version,
    "TemplateData/compersion-apple-touch-icon.png?v=" + version,
    "TemplateData/balloon_koi.png",
    "TemplateData/balloon-koi-192.png?v=" + version,
    "TemplateData/balloon-koi-512.png?v=" + version,
    "TemplateData/progress-bar-empty-dark.png",
    "TemplateData/progress-bar-full-dark.png"
];

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    self.skipWaiting();

    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames
        .filter(name => name !== cacheName &&
          (name.startsWith(cachePrefix) || name.startsWith(legacyCachePrefix)))
        .map(name => caches.delete(name)));
      await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (e) {
    if (e.request.method !== 'GET') { return; }

    e.respondWith((async function () {
      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);

      if (e.request.mode === 'navigate') {
        try {
          const response = await fetch(e.request, { cache: 'no-store' });
          if (response.ok) { await cache.put(e.request, response.clone()); }
          return response;
        } catch (error) {
          const response = await cache.match(e.request) || await cache.match("index.html");
          if (response) { return response; }
          throw error;
        }
      }

      let response = await cache.match(e.request);
      if (response) { return response; }

      response = await fetch(e.request);
      if (response.ok) {
        console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
        await cache.put(e.request, response.clone());
      }
      return response;
    })());
});
