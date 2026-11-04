// Reading time (Max, 2026-11-04: «трекати кількість хвилин, які люди проводять в читалці»). A second counts
// when a book (or a paper book's page) is on screen, the page is visible and the reader did something in the
// last few minutes: a page turn, a tap, a key, a scroll, a selection. The seconds go to the server about once
// a minute and when the page hides, per book (POST /api/reading); the server keeps them per reader, book and
// day for the admin page (server/index.js recordReading). Nobody sees them in the reader.
(() => {
  const IDLE = 3 * 60 * 1000; // no sign of life this long: the reader stepped away
  const TICK = 5000;
  const pending = {}; // book -> seconds not sent yet
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
    if (name) pending[name] = (pending[name] || 0) + step / 1000;
  }, TICK);

  function send(keepalive) {
    const books = {};
    for (const [name, sec] of Object.entries(pending)) if (sec >= 1) books[name] = Math.round(sec);
    if (!Object.keys(books).length) return;
    for (const name of Object.keys(books)) delete pending[name];
    fetch("/api/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ books }), credentials: "same-origin", keepalive })
      .then((res) => res.ok || res.status === 400 || res.status === 401 || Promise.reject(new Error(res.status)))
      // Offline or a server hiccup: the seconds wait for the next try.
      .catch(() => { for (const [name, sec] of Object.entries(books)) pending[name] = (pending[name] || 0) + sec; });
  }
  setInterval(() => send(false), 60 * 1000);
  addEventListener("pagehide", () => send(true));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send(true));

  window.ReadingTime = { poke };
})();
