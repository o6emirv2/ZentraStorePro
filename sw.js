"use strict";
const VERSION = "zentra-public-v94-r1";
const OFFLINE = "/offline.html";
const PRECACHE = [
  OFFLINE,
  "/public/assets/images/apple-touch-icon.png",
  "/public/assets/images/zentra-mark.webp",
];
function publicAsset(url) {
  return (
    url.origin === self.location.origin &&
    /^\/public\/(?:assets|css|js)\/[A-Za-z0-9_./-]+\.(?:css|js|mjs|png|jpe?g|webp|svg|ico|woff2)$/.test(
      url.pathname,
    ) &&
    !url.pathname.split("/").includes("..")
  );
}
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("zentra-public-") && key !== VERSION)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "APPLY_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin/") ||
    request.headers.has("authorization")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(VERSION).then((cache) => cache.match(OFFLINE)),
      ),
    );
    return;
  }
  if (!publicAsset(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION),
        cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (
        response.ok &&
        response.type === "basic" &&
        !response.redirected &&
        !/no-store|private/i.test(response.headers.get("cache-control") || "")
      ) {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > 100)
          for (const key of keys.slice(0, keys.length - 100))
            if (!PRECACHE.includes(new URL(key.url).pathname))
              await cache.delete(key);
      }
      return response;
    })(),
  );
});
