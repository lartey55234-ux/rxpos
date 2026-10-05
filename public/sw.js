/**
 * The app shell, so the counter still opens when the network does not.
 *
 * This caches the three files the counter is made of — nothing else. API calls are
 * deliberately left alone: a stock figure served from a cache would look current
 * and be wrong, and a pharmacy selling against a wrong number is worse than a
 * pharmacy that knows it is offline. The catalogue cache in IndexedDB is a
 * separate, clearly-labelled thing that says how old it is.
 *
 * Online, the network wins and the cache is refreshed. Offline, or on a connection
 * that has gone quiet, the cached copy is served after a short wait.
 */

const CACHE = "rxpos-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js"];
const NETWORK_PATIENCE_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function withPatience(request) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NETWORK_PATIENCE_MS)),
  ]);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        const response = await withPatience(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation that has never been cached still gets the shell if we have it.
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
      }
    })(),
  );
});
