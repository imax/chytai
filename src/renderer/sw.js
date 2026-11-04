// Service worker: keeps the reader itself (page, scripts, styles, fonts, pdf.js) on the device so it
// opens without a network. Books, notes, settings and reading positions are not handled here: the web
// bridge (web-bridge.js) keeps those in IndexedDB and syncs them when the connection is back.
//
// The server fills in VERSION and ASSETS when it serves /sw.js (server/index.js): the version is a hash
// of the reader's files, so every deploy installs a fresh copy and throws the previous one away.
const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
const CACHE = `chytai-${VERSION}`;
// Covers live in their own cache that outlives a new version: each cover is fetched once and then comes
// from the device, offline too (Max, 2026-11-01: the covers loaded again and again). Their addresses carry
// the book's date, so a changed cover is a new address.
const COVERS = "chytai-covers";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One asset at a time rather than cache.addAll: one missing file must not keep the reader from
      // working offline, and the fonts alone are a few dozen requests.
      // Only answers that came as they are: signed out, the server redirects every reader file to /login,
      // and cache.add kept that login page as style.css and renderer.js (a fresh Android app showed the
      // reader without styles). A redirected page served to a navigation fails too.
      const add = (url) => fetch(url).then((res) => res.ok && !res.redirected && cache.put(url, res));
      await Promise.all(ASSETS.map((url) => add(url).catch((err) => console.warn("sw: not cached", url, err))));
    })(),
  );
});

// A new version waits until the page is reloaded or hidden (web-bridge.js posts "skipWaiting" then), so a
// book being read keeps one consistent set of scripts; pdf.js in particular refuses a worker from another
// version. Once active, the previous version's files go.
self.addEventListener("message", (event) => event.data === "skipWaiting" && self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== COVERS) await caches.delete(key);
  })());
});

// Same-origin files of the reader are served from the cache first; anything not cached yet (a font
// weight, a pdf.js worker) is fetched once and kept. /api and the login pages always go to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === "/api/cover") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(COVERS);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        // «No cover» is kept too, or a book without one was asked about on every visit.
        if (res.ok || res.status === 404) cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
    return;
  }
  // /free/<file> (a free book from the site) is the server's: it copies the book, then redirects.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/free/") || url.pathname === "/sw.js" || /^\/(login|logout|demo|admin)$/.test(url.pathname)) return;

  if (req.mode === "navigate") {
    // Only the reader's own page. Every other address (/auth back from the site, /s/<link>, /free-file/…)
    // is the server's: served from here it lost the sign-in and the share cookie, and «Увійти» looped.
    if (url.pathname !== "/") return;
    // The page itself comes from the cache like its scripts, so they always match. A signed-out visitor
    // still ends up on /login: the page's first /api call answers 401 and the bridge sends them there.
    // The server answers / with a redirect to /login in that case, and that must not replace the page.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match("/");
        if (hit && !hit.redirected) return hit;
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
      if (res.ok && !res.redirected && (res.type === "basic" || res.type === "default")) cache.put(req, res.clone()).catch(() => {});
      return res;
    })(),
  );
});
