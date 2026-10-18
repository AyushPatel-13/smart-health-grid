/* Smart Health Grid service worker — low-connectivity support.
 *
 * Caches ONLY non-sensitive content:
 *   - immutable build assets (/_next/static/*) — cache-first
 *   - the public registration page and the offline page — network-first,
 *     falling back to the cached copy when offline
 * Everything else (patient status, dashboards, APIs, server actions) is
 * network-only and is never cached, so no personal or operational data is
 * stored by the worker.
 */
const VERSION = "shg-v1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const CACHEABLE_PAGES = ["/register", "/offline.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.addAll(["/offline.html"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // server actions (POST) always go to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(STATIC).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    const cacheable = CACHEABLE_PAGES.includes(url.pathname) && !url.search;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable && res.ok) caches.open(PAGES).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => (cacheable && (await caches.match(req))) || (await caches.match("/offline.html")) || Response.error()),
    );
  }
});
