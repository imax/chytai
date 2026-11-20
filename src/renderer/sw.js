// Service worker: keeps the reader itself (page, scripts, styles, fonts, pdf.js) on the device so it
// opens without a network. Books, notes, settings and reading positions are not handled here: the web
// bridge (web-bridge.js) keeps those in IndexedDB and syncs them when the connection is back.
//
// The server fills in VERSION and ASSETS when it serves /sw.js (server/index.js): the version is a hash
// of the reader's files, so every deploy installs a fresh copy and throws the previous one away.
const VERSION = "__VERSION__";
const BUILT = "__BUILT__"; // when this version first started on the server, for «Версія від …» in the settings
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
      // The reader's own page, scripts and styles must all come, though (2026-11-20): one left out was later fetched
      // from the network under this version and kept, a newer script beside an older page («ab-before» was null in
      // showAbout). A network error or a 5xx there, after two more tries, fails the install: the previous version
      // stays whole and the browser tries again at the next check.
      const get = async (url) => {
        for (let i = 0; ; i++) {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.status < 500 || i === 2) return res;
          } catch (err) {
            if (i === 2) throw err;
          }
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      };
      const own = (url) => url === "/" || (!url.startsWith("/node_modules/") && /\.(m?js|css)$/.test(url));
      const add = async (url) => {
        const res = await get(url);
        if (res.status >= 500 && own(url)) throw new Error(`HTTP ${res.status}`);
        if (res.ok && !res.redirected && !res.headers.get("X-Chytai-Landing")) await cache.put(url, res).catch((err) => console.warn("sw: not kept", url, err));
      };
      const failed = (await Promise.all(ASSETS.map((url) => add(url).then(() => null, (err) => (console.warn("sw: not cached", url, err), own(url) ? url : null))))).filter(Boolean);
      if (failed.length) {
        await caches.delete(CACHE);
        throw new Error(`sw: the reader's files did not come: ${failed.join(", ")}`);
      }
    })().catch((err) => {
      // Said to the server (2026-11-20: Max's iPhone kept the old version, and nothing showed why).
      fetch("/api/sw-state", { method: "POST", body: JSON.stringify({ v: VERSION, failed: String(err?.message || err).slice(0, 300) }) }).catch(() => {});
      throw err;
    }),
  );
});

// A new version waits until the page is reloaded or hidden (web-bridge.js posts "skipWaiting" then), so a
// book being read keeps one consistent set of scripts; pdf.js in particular refuses a worker from another
// version. Once active, the previous version's files go.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
  else if (event.data === "version") event.ports[0]?.postMessage({ version: VERSION, built: BUILT });
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== COVERS) await caches.delete(key);
    // Full-size covers from before the small copies (2026-11-05): their addresses end without «-s».
    const covers = await caches.open(COVERS);
    for (const r of await covers.keys()) if (!/-s$/.test(new URL(r.url).searchParams.get("v") || "")) await covers.delete(r);
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
        if (hit && !hit.redirected && !hit.headers.get("X-Chytai-Landing")) return hit;
        const res = await fetch(req);
        // Signed out, / is the landing (server/index.js signedOutPage), never the reader's page to keep.
        if (res.ok && url.pathname === "/" && !res.redirected && !res.headers.get("X-Chytai-Landing")) cache.put("/", res.clone()).catch(() => {});
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
