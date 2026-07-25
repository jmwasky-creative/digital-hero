const CACHE_NAME = "chick-number-blocks-v1";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/game/quantity-model.js",
  "/game/task-generator.js",
  "/game/storage.js",
  "/game/audio-manager.js"
];
const CORE_PATHS = new Set(CORE_ASSETS.map((asset) =>
  new URL(asset, self.location.origin).pathname
));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          const contentType = response.headers.get("content-type") || "";
          if (response.ok && contentType.includes("text/html")) {
            await caches.open(CACHE_NAME)
              .then((cache) => cache.put("/index.html", response.clone()));
          }
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  if (!CORE_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            await caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        });
    })
  );
});
