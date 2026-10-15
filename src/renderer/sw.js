// Service worker: keeps the reader itself (page, scripts, styles, fonts, pdf.js) on the device so it
// opens without a network. Books, notes, settings and reading positions are not handled here: the web
// bridge (web-bridge.js) keeps those in IndexedDB and syncs them when the connection is back.
//
// The server fills in VERSION and ASSETS when it serves /sw.js (server/index.js): the version is a hash
// of the reader's files, so every deploy installs a fresh copy and throws the previous one away.
const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
const CACHE = `chytai-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One asset at a time rather than cache.addAll: one missing file must not keep the reader from
      // working offline, and the fonts alone are a few dozen requests.
      await Promise.all(ASSETS.map((url) => cache.add(url).catch((err) => console.warn("sw: not cached", url, err))));
    })(),
  );
});

// A new version waits until the page is reloaded or hidden (web-bridge.js posts "skipWaiting" then), so a
// book being read keeps one consistent set of scripts; pdf.js in particular refuses a worker from another
// version. Once active, the previous version's files go.
self.addEventListener("message", (event) => event.data === "skipWaiting" && self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
  })());
});

// Same-origin files of the reader are served from the cache first; anything not cached yet (a font
// weight, a pdf.js worker) is fetched once and kept. /api and the login pages always go to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js" || /^\/(login|logout|demo|admin)$/.test(url.pathname)) return;

  if (req.mode === "navigate") {
    // The page itself comes from the cache like its scripts, so they always match. A signed-out visitor
    // still ends up on /login: the page's first /api call answers 401 and the bridge sends them there.
    // The server answers / with a redirect to /login in that case, and that must not replace the page.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match("/");
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && url.pathname === "/" && !res.redirected) cache.put("/", res.clone()).catch(() => {});
        return res;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (res.type === "basic" || res.type === "default")) cache.put(req, res.clone()).catch(() => {});
      return res;
    })(),
  );
});
