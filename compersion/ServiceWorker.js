const cacheName = "Ramsey Fireborn Games Studio-Compersion-0.1.0";
const contentToCache = [
    "Build/2026.07.20_build4_compersion2d.loader.js",
    "Build/2026.07.20_build4_compersion2d.framework.js.unityweb",
    "Build/2026.07.20_build4_compersion2d.data.unityweb",
    "Build/2026.07.20_build4_compersion2d.wasm.unityweb",
    "TemplateData/style.css"

];

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    
    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('fetch', function (e) {
    e.respondWith((async function () {
      let response = await caches.match(e.request);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
      if (response) { return response; }

      response = await fetch(e.request);
      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
      cache.put(e.request, response.clone());
      return response;
    })());
});
