// Reading time (Max, 2026-11-04: «трекати кількість хвилин, які люди проводять в читалці»). A second counts
// when a book (or a paper book's page) is on screen, the page is visible and the reader did something in the
// last few minutes: a page turn, a tap, a key, a scroll, a selection. The seconds go to the server about once
// a minute and when the page hides, per book (POST /api/reading); the server keeps them per reader, book and
// day for the admin page (server/index.js recordReading) and for the reader's own «Цей тиждень» (GET /api/week).
(() => {
  const IDLE = 3 * 60 * 1000; // no sign of life this long: the reader stepped away
  const TICK = 5000;
  const HOUR = 3600 * 1000;
  // Seconds not sent yet, per hour they were read in and book: { "<hour start ms>": { book: seconds } }. Kept in
  // localStorage too, so minutes read offline survive the app being closed and reach the server, under the day
  // they were read, once the network is back (Max, 2026-11-08: offline reading). Hours older than two weeks go.
  // Read and written each time rather than held in memory, so two tabs never wipe each other's seconds.
  const STORE = "chytai-reading";
  // Reading without a network (Max, 2026-11-11: «рахування читання без мережі»), per hour as well: { sec, opened,
  // missing }: seconds read offline (also counted in STORE), books opened from the device's copy, and books that
  // could not open because the device had none. Sent with the same hour's report.
  const OFF = "chytai-reading-off";
  const memory = {}; // when localStorage is unavailable (private mode, full)
  const load = (key = STORE) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") || {};
    } catch {
      return memory[key] || {};
    }
  };
  const store = (pending, key = STORE) => {
    memory[key] = pending;
    try {
      localStorage.setItem(key, JSON.stringify(pending));
    } catch {
      /* in memory only */
    }
  };
  const add = (key, books, where = STORE) => {
    const pending = load(where);
    const hour = (pending[key] ??= {});
    for (const [name, sec] of Object.entries(books)) hour[name] = (hour[name] || 0) + sec;
    store(pending, where);
  };
  const offline = () => navigator.onLine === false || document.body.classList.contains("offline");
  let lastActive = Date.now();
  let lastTick = Date.now();

  const poke = () => (lastActive = Date.now());
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) addEventListener(ev, poke, { passive: true, capture: true });
  document.addEventListener("selectionchange", poke);

  // The book on screen, if any: an e-book or PDF in the reading view, or a paper book's page.
  function onScreen() {
    if (document.body.classList.contains("reading") && typeof current !== "undefined" && current?.path) return current.path;
    const pb = window.Paper?.current?.();
    if (pb && document.querySelector(".pp")) return pb.path;
    return null;
  }

  setInterval(() => {
    const now = Date.now();
    const step = Math.min(now - lastTick, TICK * 2); // a throttled or sleeping timer does not count the gap
    lastTick = now;
    if (document.visibilityState !== "visible" || now - lastActive > IDLE) return;
    const name = onScreen();
    if (!name) return;
    add(Math.floor(now / HOUR) * HOUR, { [name]: step / 1000 });
    if (offline()) add(Math.floor(now / HOUR) * HOUR, { sec: step / 1000 }, OFF);
  }, TICK);

  // The current hour goes as it always did; an earlier hour (read offline, or the app closed before it was sent)
  // goes with `at`, its start, so the server counts it under that day. One request per hour, oldest first.
  let sending = false;
  async function send(keepalive) {
    if ((sending && !keepalive) || navigator.onLine === false) return;
    sending = true;
    try {
      const now = Date.now();
      const current = Math.floor(now / HOUR) * HOUR;
      for (const key of [...new Set([...Object.keys(load()), ...Object.keys(load(OFF))])].sort((a, b) => a - b)) {
        const pending = load();
        const pendingOff = load(OFF);
        const at = Number(key);
        const books = {};
        for (const [name, sec] of Object.entries(pending[key] || {})) if (sec >= 1) books[name] = Math.round(sec);
        const off = {};
        for (const [k, v] of Object.entries(pendingOff[key] || {})) if (v >= 1) off[k] = Math.round(v);
        const has = Object.keys(books).length || Object.keys(off).length;
        if (!Object.keys(books).length && at === current) continue;
        delete pending[key];
        delete pendingOff[key];
        store(pending);
        store(pendingOff, OFF);
        if (!(at > now - 14 * 24 * HOUR) || !has) continue;
        const body = { books, ...(at === current ? {} : { at }), ...(Object.keys(off).length ? { off } : {}) };
        try {
          const res = await fetch("/api/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", keepalive });
          if (!(res.ok || res.status === 400 || res.status === 401)) throw new Error(res.status);
        } catch {
          // Offline or a server hiccup: the seconds wait for the next try.
          add(key, books);
          add(key, off, OFF);
          return;
        }
      }
    } finally {
      sending = false;
    }
  }
  setInterval(() => send(false), 60 * 1000);
  setTimeout(() => send(false), 5000); // what waits from before (read offline) goes soon after the start
  addEventListener("pagehide", () => send(true));
  addEventListener("online", () => send(false));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send(true));

  // web-bridge.js and home.js: a book opened from the device's copy offline («opened»), or not there («missing»).
  const offlineOpen = (kind) => add(Math.floor(Date.now() / HOUR) * HOUR, { [kind]: 1 }, OFF);
  window.ReadingTime = { poke, offlineOpen };
})();
