// The owner's statistics page (/admin), Max 2026-10-20: «слідкувати за retention ну і загалом».
// Everything comes from the site's own database; no outside analytics, no scripts on the pages.
//   - visits: one row per reader per day they opened a page (the retention signal); the privacy page says so.
//   - views: how many pages were opened a day, one number for readers and one for guests, nothing else
//     (no IP, no paths). Bots and non-HTML requests are left out.
// Before the visits table existed, a reader's activity is read from what they did: sign-ups, sessions,
// shelf changes and follows, so the cohorts have some history from day one.
// Days and weeks are Kyiv time (TZ=Europe/Kyiv on Fly); a week starts on Monday.
const { esc } = require("./pages");

const BOT = /bot|crawl|spider|slurp|curl|wget|python|java\b|go-http|headless|preview|monitor|uptime|fetch|scan|facebookexternalhit|whatsapp|telegram/i;

const DAY = 86400 * 1000;
const pad = (n) => String(n).padStart(2, "0");
// YYYY-MM-DD of a moment, in the process's time zone.
const dayOf = (t) => {
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toDate = (day) => new Date(`${day}T12:00:00`); // noon: no DST surprises when stepping by days
const addDays = (day, n) => dayOf(toDate(day).getTime() + n * DAY);
// The Monday that starts the week of a day.
const weekOf = (day) => {
  const d = toDate(day);
  return addDays(day, -((d.getDay() + 6) % 7));
};
const today = () => dayOf(new Date());

// Which part of the site a page belongs to, for the views by section (Max, 2026-10-22: «головна vs
// publishers vs community»). Only the kind of page is kept, never the path itself.
const SECTIONS = [
  ["home", "Головна", (p) => p === "/"],
  ["book", "Книжки", (p) => p.startsWith("/book/")],
  ["author", "Автори", (p) => p.startsWith("/author/")],
  ["search", "Пошук", (p) => p === "/search"],
  ["popular", "Популярне", (p) => p === "/popular"],
  ["publishers", "Видавництва", (p) => p === "/publishers" || p.startsWith("/publishers/") || p.startsWith("/shelf/")],
  ["community", "Спільнота", (p) => p === "/community" || p === "/readers"],
  ["shelf", "Полиці читачів", (p) => p.startsWith("/@") || p.startsWith("/reader/")],
  ["me", "Своя полиця", (p) => p === "/me" || p.startsWith("/me/") || p === "/add" || p.startsWith("/import")],
  ["account", "Вхід і налаштування", (p) => p.startsWith("/login") || p === "/welcome" || p === "/logout" || p.startsWith("/settings") || p === "/reader-login"],
  ["other", "Інше", () => true],
];
const sectionOf = (p) => SECTIONS.find(([, , is]) => is(p))[0];

// Where visitors come from (Max, 2026-10-24: «звідки приходять»). An arrival is a page opened from another site,
// or with no referrer at the start of a visit. Kept per day: the source, the referring address without its
// query (Max: «цікаво саме з якого треду»), the page they landed on (no query either), how many and how many new.
// Cookies, all first-party and without an id: chytai_here (a visit is going on, 30 minutes), chytai_seen (was here
// before, a year) and chytai_came (where a guest first came from, 30 days, moved to their account on sign-up).
const SOURCES = [
  // [label, kind, test on the host or the utm_source]
  ["Gemini", "ai", /(^|\.)gemini\.google\.|^gemini$/],
  ["Пошта", "mail", /^mail\.google\.|outlook\.|^mail\.|(^|\.)ukr\.net$|^email$|^digest$|^newsletter$|^(e?mail\d*|webmail|exmail|email)\.|deref|kmail-lists|^links\.rediff\./],
  ["Google", "search", /(^|\.)google\.[a-z.]+$|^google$/],
  ["Bing", "search", /(^|\.)bing\.com$|^bing$/],
  ["DuckDuckGo", "search", /duckduckgo\.com$|^duckduckgo$/],
  ["Yahoo", "search", /(^|\.)yahoo\.com$/],
  ["Ecosia", "search", /ecosia\.org$/],
  ["Brave Search", "search", /search\.brave\.com$/],
  ["ChatGPT", "ai", /chatgpt\.com$|chat\.openai\.com$|^chatgpt$|^openai$/],
  ["Claude", "ai", /(^|\.)claude\.ai$|^claude$/],
  ["Perplexity", "ai", /perplexity\.ai$|^perplexity$/],
  ["Copilot", "ai", /copilot\.microsoft\.com$|^copilot$/],
  ["Telegram", "social", /(^|\.)t\.me$|telegram\.(org|me)$|^telegram$|^tg$/],
  ["Facebook", "social", /(^|\.)(facebook\.com|fb\.com|fb\.me)$|^facebook$|^fb$/],
  ["Instagram", "social", /instagram\.com$|^instagram$|^ig$/],
  ["Threads", "social", /threads\.(net|com)$|^threads$/],
  ["X", "social", /(^|\.)(x\.com|twitter\.com|t\.co)$|^x$|^twitter$/],
  ["Reddit", "social", /(^|\.)reddit\.com$|^reddit$/],
  ["LinkedIn", "social", /linkedin\.com$|lnkd\.in$|^linkedin$/],
  ["Bluesky", "social", /bsky\.app$|^bluesky$/],
  ["Mastodon", "social", /mastodon|^mstdn/],
  ["Читалка Chytai", "own", /^(app|read)\.chytai\.org\.ua$|^chytai\.fly\.dev$/],
];
const KIND = Object.fromEntries(SOURCES.map(([label, kind]) => [label, kind]));
const clean = (t, max) => String(t || "").replace(/[\u0000-\u001f<>"]/g, "").trim().slice(0, max);
// The source of an arrival: a label like «Google» or the bare host, and the address it came from.
function sourceOf(referer, query, ownHosts) {
  let host = "", ref = "";
  try {
    const u = new URL(referer);
    if (/^https?:$/.test(u.protocol)) {
      host = u.hostname.toLowerCase().replace(/^(www|m|l|lm|old|new)\./, "");
      ref = clean(host + (u.pathname === "/" ? "" : decodeURIComponent(u.pathname)).replace(/\/$/, ""), 200);
    }
  } catch {}
  if (host && ownHosts.has(host)) return null; // a page of the site itself: not an arrival
  const utm = clean(query?.utm_source, 40).toLowerCase();
  const campaign = clean(query?.utm_campaign, 80);
  const key = utm || host;
  if (!key) return { source: "Напряму", ref: "" };
  const known = SOURCES.find(([, , re]) => re.test(key));
  return { source: known ? known[0] : key, ref: campaign ? `кампанія: ${campaign}` : ref };
}
// Links of a letter back to the site carry utm_source=email and the letter's name, so «Звідки приходять» shows
// what each letter brings («Пошта», «кампанія: digest»; Max, 2026-10-29). Unsubscribing and settings stay bare.
function mailLinks(s, site, campaign, html = false) {
  const re = new RegExp(`${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^"'\\s<>]*)?`, "g");
  return String(s).replace(re, (url) => {
    if (/\/(unsubscribe|resubscribe|settings)(\/|$|\?)/.test(url)) return url;
    const [base, hash = ""] = url.split("#");
    return `${base}${base.includes("?") ? (html ? "&amp;" : "&") : "?"}utm_source=email${html ? "&amp;" : "&"}utm_campaign=${campaign}${hash ? `#${hash}` : ""}`;
  });
}
const ARRIVAL_DAYS = 28;
const SECTION_NAMES = Object.fromEntries(SECTIONS.map(([id, name]) => [id, name]));

class Admin {
  constructor(db, { ownerId = "owner" } = {}) {
    this.db = db;
    this.ownerId = ownerId;
    this.seen = new Set(); // `${day}:${reader}` already written today
    this.seenDay = "";
    // The funnel counts readers who signed up from the day the steps started being kept.
    if (!db.get("steps:since")) db.set("steps:since", new Date().toISOString());
  }

  // A page opened: remember the reader's day and count the view. Cheap: one insert per reader a day,
  // one upsert per view (SQLite in WAL mode takes that without noticing at this size).
  touch(req, readerId) {
    if (req.method !== "GET") return;
    const accept = req.headers.accept || "";
    if (accept && !accept.includes("text/html")) return;
    const p = req.path || "";
    if (p.startsWith("/api/") || p === "/refresh-status" || p === "/admin" || p.startsWith("/admin/") || p.includes(".")) return;
    if (BOT.test(req.headers["user-agent"] || "") || !req.headers["accept-language"]) return; // browsers always send Accept-Language, most crawlers with a browser's user agent don't (2026-10-26)
    const day = today();
    if (day !== this.seenDay) (this.seen = new Set()), (this.seenDay = day);
    try {
      if (readerId) {
        const key = `${day}:${readerId}`;
        if (!this.seen.has(key)) {
          this.seen.add(key);
          this.db.prepare("INSERT OR IGNORE INTO visits (day, reader) VALUES (?, ?)").run(day, readerId);
        }
      }
      this.db.prepare(`INSERT INTO views (day, readers, guests) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET readers = readers + excluded.readers, guests = guests + excluded.guests`).run(day, readerId ? 1 : 0, readerId ? 0 : 1);
      this.db.prepare(`INSERT INTO section_views (day, section, views) VALUES (?, ?, 1) ON CONFLICT (day, section) DO UPDATE SET views = views + 1`).run(day, sectionOf(p));
    } catch (e) {
      console.error("admin touch failed:", e.message);
    }
  }

  // An arrival on the site (see SOURCES): counted once at the start of a visit, or whenever a page is opened from
  // another site. Same filters as touch(), plus browser prefetches. Sets the three cookies described above.
  arrive(req, res, readerId, { cookies = {}, ownHosts = new Set(), secure = false } = {}) {
    if (req.method !== "GET" || readerId === this.ownerId) return;
    const accept = req.headers.accept || "";
    if (accept && !accept.includes("text/html")) return;
    const p = req.path || "";
    if (p.startsWith("/api/") || p === "/refresh-status" || p === "/admin" || p.startsWith("/admin/") || p.includes(".") || p === "/mcp" || p.startsWith("/oauth/")) return;
    if (BOT.test(req.headers["user-agent"] || "") || !req.headers["accept-language"] || /prefetch|prerender/i.test(req.headers["sec-purpose"] || req.headers.purpose || "")) return;
    try {
      const referer = req.headers.referer || req.headers.referrer || "";
      const from = sourceOf(referer, req.query, ownHosts);
      const set = [];
      const tail = `; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
      set.push(`chytai_here=1; Max-Age=1800${tail}`);
      const arrival = from && (referer || !cookies.chytai_here);
      // A guest's visit, for «Що роблять гості» (Max, 2026-10-26: people from Google land on a book and leave):
      // chytai_q says the visit began at a search engine or an AI chat, chytai_more that a second page was opened.
      if (!readerId && arrival) {
        const q = ["search", "ai"].includes(KIND[from.source]);
        set.push(`chytai_q=${q ? 1 : 0}; Max-Age=1800${tail}`, `chytai_more=; Max-Age=0${tail}`);
        this.guestStep("arrive", q);
      } else if (!readerId && cookies.chytai_here && !cookies.chytai_more) {
        set.push(`chytai_more=1; Max-Age=1800${tail}`);
        this.guestStep("second", cookies.chytai_q === "1");
      }
      if (arrival) {
        const fresh = !readerId && !cookies.chytai_seen ? 1 : 0;
        const landing = clean(decodeURIComponent(p), 120) || "/";
        this.db.prepare(`INSERT INTO arrivals (day, source, ref, landing, visits, fresh) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (day, source, ref, landing) DO UPDATE SET visits = visits + 1, fresh = fresh + excluded.fresh`).run(today(), from.source, from.ref, landing, fresh);
        if (!readerId && !cookies.chytai_came && from.source !== "Напряму") set.push(`chytai_came=${encodeURIComponent(JSON.stringify({ source: from.source, ref: from.ref, landing, day: today() }))}; Max-Age=${30 * 86400}${tail}`);
      }
      if (!cookies.chytai_seen) set.push(`chytai_seen=1; Max-Age=${365 * 86400}${tail}`);
      res.append("Set-Cookie", set);
    } catch (e) {
      console.error("admin arrive failed:", e.message);
    }
  }

  // One step of a guest's visit (arrive, second, want, read, epub), counted per day and by whether the visit began
  // at a search engine or an AI chat. No id, nothing else kept.
  guestStep(step, search) {
    try {
      this.db.prepare(`INSERT INTO guest_steps (day, step, search, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, step, search) DO UPDATE SET n = n + 1`).run(today(), step, search ? 1 : 0);
    } catch (e) {
      console.error("admin guestStep failed:", e.message);
    }
  }
  // The same for a step taken by a request (a guest's tap): a crawler or the owner is not counted.
  guestTap(req, readerId, step, cookies = {}) {
    if (readerId || BOT.test(req.headers["user-agent"] || "") || !req.headers["accept-language"]) return;
    this.guestStep(step, cookies.chytai_q === "1");
  }

  // A search on the site (Max, 2026-10-29: «Записуємо звісно»): the query as typed, lowercased, and how many
  // results it got, counted per day. No reader, no address, nothing else; crawlers and the owner not counted.
  searched(req, readerId, q, hits) {
    q = String(q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
    if (q.length < 2 || !this.counted(req, readerId)) return;
    try {
      this.db.prepare(`INSERT INTO search_log (day, q, n, hits) VALUES (?, ?, 1, ?) ON CONFLICT (day, q) DO UPDATE SET n = n + 1, hits = excluded.hits`).run(today(), q, hits | 0);
    } catch (e) {
      console.error("admin searched failed:", e.message);
    }
  }
  // The last month's searches for /admin/catalog: the most asked, and the ones that found nothing.
  searches(days = 30) {
    const since = dayOf(new Date(Date.now() - days * 86400000));
    const rows = this.db.prepare("SELECT q, SUM(n) AS n, MAX(hits) AS hits FROM search_log WHERE day >= ? GROUP BY q ORDER BY n DESC, q").all(since);
    const first = this.db.prepare("SELECT MIN(day) AS d FROM search_log").get()?.d || null;
    const clicks = this.db.prepare("SELECT SUM(n) AS n FROM taps WHERE block = 'search' AND target != 'search' AND day >= ?").get(since)?.n || 0;
    return { clicks, since: first && first > since ? first : since, started: first, total: rows.reduce((a, r) => a + r.n, 0), queries: rows.length, none: rows.filter((r) => !r.hits).reduce((a, r) => a + r.n, 0), top: rows.slice(0, 30), empty: rows.filter((r) => !r.hits).slice(0, 30) };
  }

  // Is this request a person worth counting? Crawlers, the owner and requests without a browser's
  // Accept-Language are not.
  counted(req, readerId) {
    return readerId !== this.ownerId && !BOT.test(req.headers["user-agent"] || "") && !!req.headers["accept-language"];
  }
  // A tap on a link or a button (Max, 2026-10-29: «норм інструментацію … щоб мати дані для продуктових рішень»),
  // sent by app.js: the kind of page (SECTIONS), the block it sat in (data-block), what it led to and, for a
  // book in a row, its place there. Counted per day, guests apart from readers; no id, no address, no query.
  tap(req, readerId, { path, block, target, pos }) {
    if (!this.counted(req, readerId)) return;
    const page = sectionOf(String(path || "/").slice(0, 200));
    block = /^[a-z0-9-]{1,30}$/.test(block || "") ? block : "-";
    target = String(target || "").toLowerCase().slice(0, 60);
    if (!/^[a-z0-9][a-z0-9:._\-]*$/.test(target)) return;
    pos = ["1", "2", "3", "4-6", "7-10", "11+"].includes(pos) ? pos : "";
    try {
      this.db.prepare(`INSERT INTO taps (day, page, block, target, pos, guest, n) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (day, page, block, target, pos, guest) DO UPDATE SET n = n + 1`).run(today(), page, block, target, pos, readerId ? 0 : 1);
    } catch (e) {
      console.error("admin tap failed:", e.message);
    }
  }
  // Something that is not a tap: a step of signing in, a page not found, a script error in the browser.
  event(req, readerId, name, prop = "") {
    if (!this.counted(req, readerId)) return;
    try {
      this.db.prepare(`INSERT INTO events (day, name, prop, guest, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, name, prop, guest) DO UPDATE SET n = n + 1`).run(today(), name, clean(prop, 120), readerId ? 0 : 1);
    } catch (e) {
      console.error("admin event failed:", e.message);
    }
  }
  // The last month's taps for /admin/traffic: per page and block, what was tapped, guests and readers apart.
  taps(days = 30) {
    const since = dayOf(new Date(Date.now() - days * 86400000));
    const rows = this.db.prepare("SELECT page, block, target, pos, SUM(CASE WHEN guest = 1 THEN n ELSE 0 END) AS guests, SUM(CASE WHEN guest = 0 THEN n ELSE 0 END) AS readers FROM taps WHERE day >= ? GROUP BY page, block, target, pos").all(since);
    const views = Object.fromEntries(this.db.prepare("SELECT section, SUM(views) AS v FROM section_views WHERE day >= ? GROUP BY section").all(since).map((r) => [r.section, r.v]));
    const first = this.db.prepare("SELECT MIN(day) AS d FROM taps").get()?.d || null;
    return { since: first && first > since ? first : since, started: first, rows, views, names: SECTION_NAMES };
  }
  // The last month's events of one name, most frequent first: [{ prop, guests, readers, n }].
  events(name, days = 30) {
    const since = dayOf(new Date(Date.now() - days * 86400000));
    return this.db.prepare("SELECT prop, SUM(CASE WHEN guest = 1 THEN n ELSE 0 END) AS guests, SUM(CASE WHEN guest = 0 THEN n ELSE 0 END) AS readers, SUM(n) AS n FROM events WHERE name = ? AND day >= ? GROUP BY prop ORDER BY n DESC").all(name, since);
  }

  // A new reader: keep where they first came from (the chytai_came cookie, else «Напряму»).
  came(readerId, cookie) {
    let c = null;
    try {
      c = JSON.parse(cookie || "null");
    } catch {}
    const came = c && typeof c === "object" ? { source: clean(c.source, 60), ref: clean(c.ref, 200), landing: clean(c.landing, 120), day: clean(c.day, 10) } : { source: "Напряму", ref: "", landing: "", day: today() };
    try {
      this.db.prepare("UPDATE readers SET came = ? WHERE id = ?").run(JSON.stringify(came), readerId);
    } catch (e) {
      console.error("admin came failed:", e.message);
    }
  }

  // Arrivals of the last 7 and 28 days: by source, by referring address, and the pages people land on from
  // search engines and AI chats. Sign-ups by source come from readers.came.
  arrivals(readers, now) {
    const week7 = addDays(now, -6), month = addDays(now, -(ARRIVAL_DAYS - 1));
    const rows = this.db.prepare("SELECT day, source, ref, landing, visits, fresh FROM arrivals WHERE day >= ?").all(month);
    const since = this.db.prepare("SELECT MIN(day) AS d FROM arrivals").get()?.d || null;
    const bySource = {}, byRef = {}, byLanding = {};
    const add = (m, key, extra, r) => {
      const x = (m[key] ||= { ...extra, week: 0, weekNew: 0, month: 0, monthNew: 0, signups: 0 });
      if (r.day >= week7) (x.week += r.visits), (x.weekNew += r.fresh);
      x.month += r.visits;
      x.monthNew += r.fresh;
    };
    // Rows kept before a host got its label (webmail hosts → «Пошта», 2026-10-26) are relabelled here.
    const label = (src) => (KIND[src] || src === "Напряму" ? src : SOURCES.find(([, , re]) => re.test(src))?.[0] || src);
    for (const r0 of rows) {
      const r = { ...r0, source: label(r0.source) };
      add(bySource, r.source, { source: r.source, kind: KIND[r.source] || (r.source === "Напряму" ? "direct" : "other") }, r);
      if (r.ref.includes("/") || r.ref.startsWith("кампанія")) add(byRef, `${r.source}\t${r.ref}`, { source: r.source, ref: r.ref }, r);
      if (["search", "ai"].includes(KIND[r.source])) add(byLanding, r.landing, { landing: r.landing }, r);
    }
    for (const rd of readers) {
      if (rd.id === this.ownerId || !rd.came || dayOf(rd.created) < month) continue;
      let c;
      try {
        c = JSON.parse(rd.came);
      } catch {
        continue;
      }
      const src = label(c.source);
      const x = (bySource[src] ||= { source: src, kind: KIND[src] || (src === "Напряму" ? "direct" : "other"), week: 0, weekNew: 0, month: 0, monthNew: 0, signups: 0 });
      x.signups++;
    }
    const top = (m, k = 20) => Object.values(m).sort((a, b) => b.month - a.month || b.week - a.week).slice(0, k);
    // By weeks, for the weekly table on /admin/traffic (twelve weeks back).
    const weeks = this.db.prepare("SELECT day, SUM(visits) AS visits, SUM(fresh) AS fresh FROM arrivals WHERE day >= ? GROUP BY day").all(weekOf(addDays(now, -83)));
    const byWeek = {};
    for (const r of weeks) {
      const x = (byWeek[weekOf(r.day)] ||= { week: weekOf(r.day), visits: 0, fresh: 0 });
      x.visits += r.visits;
      x.fresh += r.fresh;
    }
    // What guests do after they arrive, 28 days; sign-ups by whether they first came from search or an AI chat.
    const guests = { search: {}, other: {} };
    for (const r of this.db.prepare("SELECT step, search, SUM(n) AS n FROM guest_steps WHERE day >= ? GROUP BY step, search").all(month)) guests[r.search ? "search" : "other"][r.step] = r.n;
    const stepsSince = this.db.prepare("SELECT MIN(day) AS d FROM guest_steps").get()?.d || null;
    for (const rd of readers) {
      if (rd.id === this.ownerId || !rd.came || dayOf(rd.created) < (stepsSince || "9999")) continue;
      try {
        const k = ["search", "ai"].includes(KIND[label(JSON.parse(rd.came).source)]) ? "search" : "other";
        guests[k].signup = (guests[k].signup || 0) + 1;
      } catch {}
    }
    return { since, sources: top(bySource, 200), refs: top(byRef, 60), landings: top(byLanding, 60), weeks: Object.values(byWeek), guests: stepsSince ? { ...guests, since: stepsSince } : null };
  }

  // The first time a reader got to a step of adding books: «welcome» (/welcome), «add» (/add), «review» (the
  // list or file looked at, before confirming), «saved» (confirmed). For the funnel on /admin (Max, 2026-10-22):
  // where new readers stop before their books are on the shelf. Nothing else is kept, not what they pasted.
  step(readerId, step) {
    if (!readerId || readerId === this.ownerId) return;
    try {
      this.db.prepare("INSERT OR IGNORE INTO steps (reader, step, at) VALUES (?, ?, ?)").run(readerId, step, new Date().toISOString());
    } catch (e) {
      console.error("admin step failed:", e.message);
    }
  }

  // ---- the numbers ----

  stats({ weeks = 12 } = {}) {
    const db = this.db;
    const readers = db.prepare("SELECT * FROM readers ORDER BY created").all();
    const entries = db.prepare("SELECT reader, book, status, rating, note, added, updated FROM entries").all();
    const follows = db.prepare("SELECT reader, target, created FROM follows").all();
    const sessions = db.prepare("SELECT reader, created, seen FROM sessions").all();
    const visits = db.prepare("SELECT day, reader FROM visits").all();
    const views = Object.fromEntries(db.prepare("SELECT day, readers, guests FROM views").all().map((v) => [v.day, v]));
    const sectionRows = db.prepare("SELECT day, section, views FROM section_views").all();
    const digestLog = db.prepare("SELECT reader, sent FROM digest_log").all();

    // Which days each reader was around: visits, plus everything else that leaves a date.
    // A day before the reader signed up is not theirs: an import from Goodreads keeps the dates the
    // books were added there (one reader showed «200 днів» on day two).
    const active = new Map(); // reader -> Set(day)
    const signedUp = Object.fromEntries(readers.map((r) => [r.id, dayOf(r.created)]));
    const mark = (reader, iso) => {
      const day = iso && dayOf(iso);
      if (!day || !reader || day < (signedUp[reader] || day)) return;
      if (!active.has(reader)) active.set(reader, new Set());
      active.get(reader).add(day);
    };
    for (const v of visits) mark(v.reader, toDate(v.day));
    for (const r of readers) mark(r.id, r.created), mark(r.id, r.seen);
    for (const s of sessions) mark(s.reader, s.created), mark(s.reader, s.seen);
    for (const e of entries) mark(e.reader, e.added), mark(e.reader, e.updated);
    for (const f of follows) mark(f.reader, f.created);

    const now = today();
    const thisWeek = weekOf(now);
    const byReader = (list, key = "reader") => {
      const m = new Map();
      for (const x of list) m.set(x[key], (m.get(x[key]) || 0) + 1);
      return m;
    };
    const activeSince = (fromDay, toDay = now) => [...active].filter(([, days]) => [...days].some((d) => d >= fromDay && d <= toDay)).map(([r]) => r);
    const created = Object.fromEntries(readers.map((r) => [r.id, dayOf(r.created)]));

    // The weeks, oldest first, ending with the current one: from the week the first reader signed up
    // (Max, 2026-10-21: no empty weeks from before the launch), at most `weeks` of them.
    const firstWeek = weekOf(readers.map((r) => dayOf(r.created)).filter(Boolean).sort()[0] || now);
    const weekList = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const w = addDays(thisWeek, -7 * i);
      if (w >= firstWeek) weekList.push(w);
    }
    const inWeek = (iso, w) => {
      const d = iso && dayOf(iso);
      return d && d >= w && d < addDays(w, 7);
    };
    const weekRows = weekList.map((w) => {
      const end = addDays(w, 6);
      const act = activeSince(w, end);
      const fresh = act.filter((r) => created[r] >= w);
      let rv = 0, gv = 0;
      for (let d = w; d <= end; d = addDays(d, 1)) (rv += views[d]?.readers || 0), (gv += views[d]?.guests || 0);
      return {
        week: w,
        current: w === thisWeek,
        signups: readers.filter((r) => inWeek(r.created, w)).length,
        active: act.length,
        returning: act.length - fresh.length,
        books: entries.filter((e) => inWeek(e.added, w)).length,
        ratings: entries.filter((e) => e.rating && inWeek(e.updated || e.added, w)).length,
        notes: entries.filter((e) => e.note && inWeek(e.updated || e.added, w)).length,
        follows: follows.filter((f) => inWeek(f.created, w)).length,
        digest: digestLog.filter((d) => inWeek(d.sent, w)).length,
        views: { readers: rv, guests: gv, tracked: [...Array(7)].some((_, i) => views[addDays(w, i)]) },
      };
    });

    // Cohorts by sign-up week: who of them came back in week 1, 2, 3, 4 and 8 after.
    const LATER = [1, 2, 3, 4, 8];
    const cohorts = weekList
      .map((w) => {
        const members = readers.filter((r) => inWeek(r.created, w) && r.id !== this.ownerId);
        const later = LATER.map((n) => {
          const from = addDays(w, 7 * n);
          if (from > now) return null; // not yet
          const to = addDays(from, 6);
          const back = members.filter((r) => [...(active.get(r.id) || [])].some((d) => d >= from && d <= to)).length;
          return { n, back, pct: members.length ? Math.round((100 * back) / members.length) : 0, partial: to > now };
        });
        return { week: w, size: members.length, later };
      })
      .filter((c) => c.size);

    // From sign-up to books on the shelf, for readers who signed up once the steps were counted.
    const since = db.get("steps:since");
    const steps = db.prepare("SELECT reader, step FROM steps").all();
    const reached = (step) => new Set(steps.filter((x) => x.step === step).map((x) => x.reader));
    const shelfCount = byReader(entries);
    const funnelOf = (list) => {
      const ids = new Set(list.map((r) => r.id));
      const of = (set) => [...set].filter((id) => ids.has(id)).length;
      return {
        signups: list.length,
        welcome: of(reached("welcome")),
        add: of(reached("add")),
        review: of(reached("review")),
        saved: of(reached("saved")),
        one: list.filter((r) => (shelfCount.get(r.id) || 0) >= 1).length,
        ten: list.filter((r) => (shelfCount.get(r.id) || 0) >= 10).length,
      };
    };
    const others = readers.filter((r) => r.id !== this.ownerId);
    const funnel = { since: since ? dayOf(since) : null, fresh: since ? funnelOf(others.filter((r) => r.created >= since)) : null, all: funnelOf(others) };

    const books = byReader(entries);
    const ratings = byReader(entries.filter((e) => e.rating));
    const notes = byReader(entries.filter((e) => e.note));
    const following = byReader(follows);
    const followers = byReader(follows, "target");
    const lastDigest = Object.fromEntries(digestLog.map((d) => [d.reader, d.sent]));
    const readerRows = readers
      .map((r) => {
        const days = [...(active.get(r.id) || [])].sort();
        return {
          id: r.id,
          name: r.name,
          username: r.username,
          owner: r.id === this.ownerId,
          email: !!r.email,
          created: dayOf(r.created),
          at: r.created,
          last: days[days.length - 1] || null,
          days: days.length,
          books: books.get(r.id) || 0,
          ratings: ratings.get(r.id) || 0,
          notes: notes.get(r.id) || 0,
          following: following.get(r.id) || 0,
          followers: followers.get(r.id) || 0,
          digest: r.digest !== 0 && !!r.email,
          came: (() => { try { return JSON.parse(r.came || "null"); } catch { return null; } })(),
          lastDigest: lastDigest[r.id] ? dayOf(lastDigest[r.id]) : null,
        };
      })
      .sort((a, b) => (b.last || "").localeCompare(a.last || "") || a.created.localeCompare(b.created));

    const week7 = addDays(now, -6), month = addDays(now, -27);
    const people = readers.filter((r) => r.id !== this.ownerId);
    const digestLast = JSON.parse(db.get("digest:last") || "null");
    return {
      now,
      totals: {
        readers: people.length,
        signupsWeek: people.filter((r) => dayOf(r.created) >= week7).length,
        signupsMonth: people.filter((r) => dayOf(r.created) >= month).length,
        activeToday: activeSince(now).filter((r) => r !== this.ownerId).length,
        activeWeek: activeSince(week7).filter((r) => r !== this.ownerId).length,
        activeMonth: activeSince(month).filter((r) => r !== this.ownerId).length,
        returningWeek: activeSince(week7).filter((r) => r !== this.ownerId && created[r] < week7).length,
        entries: entries.length,
        entriesWeek: entries.filter((e) => e.added && dayOf(e.added) >= week7).length,
        ratings: entries.filter((e) => e.rating).length,
        notes: entries.filter((e) => e.note).length,
        want: entries.filter((e) => e.status === "want").length,
        follows: follows.length,
        digestOn: readers.filter((r) => r.digest !== 0 && r.email).length,
        digestOff: readers.filter((r) => r.digest === 0 && r.email).length,
        sessions: sessions.length,
        viewsWeek: Object.values(views).filter((v) => v.day >= week7).reduce((s, v) => ({ readers: s.readers + v.readers, guests: s.guests + v.guests }), { readers: 0, guests: 0 }),
        viewsSince: Object.keys(views).sort()[0] || null,
      },
      weeks: weekRows,
      sections: this.sections(sectionRows, now),
      arrivals: this.arrivals(readers, now),
      funnel,
      cohorts,
      later: LATER,
      readers: readerRows,
      digest: digestLast ? { ...digestLast, lastRun: db.get("digest:lastRun") } : null,
    };
  }

  // Page views by part of the site: today, the last 7 and 28 days, most viewed first.
  sections(rows, now) {
    const week7 = addDays(now, -6), month = addDays(now, -27);
    const sum = {};
    for (const r of rows) {
      const x = (sum[r.section] ||= { id: r.section, name: SECTION_NAMES[r.section] || r.section, today: 0, week: 0, month: 0 });
      if (r.day === now) x.today += r.views;
      if (r.day >= week7) x.week += r.views;
      if (r.day >= month) x.month += r.views;
    }
    return Object.values(sum).sort((a, b) => b.week - a.week || b.month - a.month);
  }
}

// ---- the page ----

const n = (v) => (v ? String(v) : `<span class="zero">0</span>`);
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const short = (day) => (day ? `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : "—");
const weekLabel = (w) => `${short(w)} – ${short(addDays(w, 6))}`;
const tile = (value, label, sub = "") => `<div class="stat"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
const pct = (c) => (c === null ? `<td class="na">·</td>` : `<td class="pct${c.partial ? " partial" : ""}${c.pct >= 50 ? " hi" : c.pct > 0 ? " mid" : ""}" title="${c.back} з когорти${c.partial ? ", тиждень ще триває" : ""}">${c.pct}%</td>`);

// From sign-up to books on the shelf (Max, 2026-10-22: «чи працює /add у нових читачів»). The steps are counted
// from the day they started (`since`); the shelf counts (1+, 10+) are for every reader.
function funnelBlock(f) {
  if (!f) return "";
  const share = (v, of) => (of ? `${v} <span class="muted">· ${Math.round((100 * v) / of)}%</span>` : n(v));
  const x = f.fresh;
  const rows = x
    ? [
        ["Зареєструвались", x.signups],
        ["Відкрили «Ласкаво просимо»", x.welcome],
        ["Відкрили «Додати книжки»", x.add],
        ["Дійшли до перевірки списку чи файлу", x.review],
        ["Підтвердили, книжки на полиці", x.saved],
        ["1+ книжка на полиці", x.one],
        ["10+ книжок на полиці", x.ten],
      ]
        .map(([l, v]) => `<tr><th>${l}</th><td>${share(v, x.signups)}</td></tr>`)
        .join("")
    : "";
  return `<h2>Від реєстрації до полиці</h2>
<p class="muted small">${x ? `Нові читачі з ${short(f.since)}, коли почали рахувати кроки; частка від тих, хто зареєструвався. Кожен крок рахується раз на читача, без того, що він вставив.` : ""} За весь час (читачів: ${f.all.signups}) у ${share(f.all.one, f.all.signups)} є хоч одна книжка, у ${share(f.all.ten, f.all.signups)} 10 і більше.</p>
${x ? `<div class="tbl"><table class="funnel"><tbody>${rows}</tbody></table></div>` : ""}`;
}

// «Звідки приходять» (Max, 2026-10-24): arrivals by source, the exact addresses when the other site passes them,
// and the pages people land on from search engines and AI chats.
const KIND_NAMES = { search: "пошук", ai: "AI-чат", social: "соцмережа", mail: "пошта", own: "наше", direct: "", other: "сайт" };
function sourcesTable(a, limit = Infinity) {
  const pair = (v, fresh) => `${n(v)}${v ? ` <span class="muted">/ ${fresh}</span>` : ""}`;
  const rows = a.sources.slice(0, limit).map((x) => `<tr><th>${esc(x.source)}${KIND_NAMES[x.kind] && KIND_NAMES[x.kind] !== x.source.toLowerCase() ? ` <span class="muted">${KIND_NAMES[x.kind]}</span>` : ""}</th><td>${pair(x.week, x.weekNew)}</td><td>${pair(x.month, x.monthNew)}</td><td>${n(x.signups)}</td></tr>`).join("");
  return a.sources.length ? `<div class="tbl"><table class="sources">
<thead><tr><th>Джерело</th><th>7 днів</th><th>28 днів</th><th>Реєстрацій</th></tr></thead>
<tbody>${rows}</tbody></table></div>` : `<p class="muted">Поки нікого не нарахувалось.</p>`;
}

// /admin/traffic, redone 2026-10-26 (Max: «блоки дублюються, важлива інфа губиться»): the month in four numbers,
// sources grouped by kind with the exact addresses under them, one weekly table for our counter and Google,
// Google's queries, and the pages people land on (Google Search Console and our counter side by side).
const KIND_ORDER = [["search", "Пошук"], ["ai", "AI-чати"], ["social", "Соцмережі"], ["mail", "Пошта"], ["other", "Інші сайти"], ["own", "Читалка Chytai"], ["direct", "Напряму"]];
const fmtN = (v, digits = 0) => v.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const sumGsc = (rows) => {
  const c = rows.reduce((a, r) => a + r.clicks, 0);
  const i = rows.reduce((a, r) => a + r.impressions, 0);
  return { clicks: c, impressions: i, ctr: i ? (100 * c) / i : 0, position: i ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / i : 0 };
};
const pathOf = (u) => { try { const x = new URL(u); return decodeURIComponent(x.pathname + x.search); } catch { return u; } };

function trafficBody(s, g, gscOn) {
  const a = s.arrivals;
  const hasG = !!g?.days;
  const short7 = !a.since || a.since > addDays(s.now, -6); // under a week of data: 7 and 28 days are the same
  const since = a.since ? short(a.since) : "сьогодні";

  // The four numbers.
  const all = a.sources.reduce((t, x) => ({ month: t.month + x.month, fresh: t.fresh + x.monthNew, week: t.week + x.week, signups: t.signups + x.signups }), { month: 0, fresh: 0, week: 0, signups: 0 });
  const signups = s.weeks.filter((w) => w.week >= weekOf(addDays(s.now, -27))).reduce((t, w) => t + w.signups, 0);
  let gNow = null, gBefore = null;
  if (hasG) {
    gNow = sumGsc(g.days.filter((d) => d.day >= g.from && d.day <= g.to));
    const before = g.days.filter((d) => d.day >= addDays(g.from, -28) && d.day < g.from);
    gBefore = before.length >= 20 ? sumGsc(before) : null;
  }
  const change = (x, y) => (y ? `${x >= y ? "+" : "−"}${Math.round((100 * Math.abs(x - y)) / y)}% до попередніх 28 днів` : "");
  const tiles = `<div class="stats four">
${tile(fmtN(all.month), "відвідувань", short7 ? `з ${since}` : `${fmtN(all.week)} за 7 днів`)}
${tile(fmtN(all.fresh), "нових людей", all.month ? `${Math.round((100 * all.fresh) / all.month)}% відвідувань` : "")}
${tile(fmtN(signups), "реєстрацій", all.fresh ? `${fmtN((100 * signups) / all.fresh, 1)}% нових людей` : "")}
${hasG ? tile(fmtN(gNow.clicks), "кліків з Google", gBefore ? change(gNow.clicks, gBefore.clicks) : `${fmtN(gNow.impressions)} показів · позиція ${fmtN(gNow.position, 1)}`) : tile("·", "кліків з Google", gscOn ? "ще завантажується" : "не підключено")}
</div>
<p class="muted small">Відвідування й нові люди за 28 днів (рахуємо з ${since}): відвідування — прихід з іншого сайту або початок візиту, нові — ті, хто раніше не був. Google — за ${hasG ? `${short(g.from)} – ${short(g.to)}, його дані відстають на 2–3 дні` : "28 днів"}.</p>`;

  // Sources by kind, each with its sources, and the exact addresses under a source when the site passed them.
  const refsOf = (src) => a.refs.filter((r) => r.source === src).slice(0, 5);
  const link = (ref) => (ref.startsWith("кампанія") ? esc(ref) : `<a href="https://${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref.length > 60 ? ref.slice(0, 60) + "…" : ref)}</a>`);
  const cells = (x) => `${short7 ? "" : `<td>${n(x.week)}</td>`}<td>${n(x.month)}</td><td>${n(x.monthNew)}</td><td>${n(x.signups)}</td>`;
  const groups = KIND_ORDER.map(([kind, name]) => {
    const list = a.sources.filter((x) => (x.kind || "other") === kind);
    if (!list.length) return null;
    const t = list.reduce((t, x) => ({ week: t.week + x.week, month: t.month + x.month, monthNew: t.monthNew + x.monthNew, signups: t.signups + x.signups }), { week: 0, month: 0, monthNew: 0, signups: 0 });
    return { kind, name, list, t };
  }).filter(Boolean).sort((x, y) => y.t.month - x.t.month);
  const body = groups.map(({ kind, name, list, t }) => {
    const single = list.length === 1 && (list[0].source === name || kind === "direct" || kind === "own");
    const tail = list.filter((x) => x.month <= 1);
    const few = tail.length > 1 ? tail : [];
    const many = list.filter((x) => !few.includes(x));
    const rows = single ? [] : [
      ...many.map((x) => `<tr class="src"><th>${esc(x.source)}${refsOf(x.source).map((r) => `<div class="ref">${link(r.ref)} <span>${r.month}</span></div>`).join("")}</th>${cells(x)}</tr>`),
      ...(few.length ? [`<tr class="src"><th><span class="muted">ще ${few.length} по одному: ${few.slice(0, 6).map((x) => esc(x.source)).join(", ")}${few.length > 6 ? "…" : ""}</span></th>${cells(few.reduce((t, x) => ({ week: t.week + x.week, month: t.month + x.month, monthNew: t.monthNew + x.monthNew, signups: t.signups + x.signups }), { week: 0, month: 0, monthNew: 0, signups: 0 }))}</tr>`] : []),
    ];
    return `<tr class="kind"><th>${name}</th>${cells(t)}</tr>${rows.join("")}`;
  }).join("");
  const sources = a.sources.length ? `<div class="tbl"><table class="sources grouped">
<thead><tr><th>Джерело</th>${short7 ? "" : "<th>7 днів</th>"}<th>${short7 ? `З ${since}` : "28 днів"}</th><th>Нових</th><th>Реєстрацій</th></tr></thead>
<tbody>${body}</tbody></table></div>` : `<p class="muted">Поки нікого не нарахувалось.</p>`;

  // One table by weeks: our counter, sign-ups and Google.
  const gWeeks = new Map();
  for (const d of hasG ? g.days : []) {
    const w = weekOf(d.day);
    if (!gWeeks.has(w)) gWeeks.set(w, []);
    gWeeks.get(w).push(d);
  }
  const weekKeys = [...new Set([...a.weeks.map((w) => w.week), ...gWeeks.keys(), ...s.weeks.map((w) => w.week).filter((w) => w >= (a.since ? weekOf(a.since) : s.now) || gWeeks.has(w))])].sort().reverse().slice(0, 12);
  const weekRows = weekKeys.map((w) => {
    const ours = a.weeks.find((x) => x.week === w);
    const site = s.weeks.find((x) => x.week === w);
    const gw = gWeeks.get(w) ? sumGsc(gWeeks.get(w)) : null;
    const now = w === weekOf(s.now);
    const na = `<td class="na">·</td>`;
    return `<tr${now ? ' class="now"' : ""}><th>${weekLabel(w)}${now ? " <em>зараз</em>" : ""}</th>${ours ? `<td>${n(ours.visits)}</td><td>${n(ours.fresh)}</td>` : na + na}<td>${n(site?.signups || 0)}</td>${gw ? `<td>${n(gw.clicks)}</td><td>${n(gw.impressions)}</td><td>${gw.impressions ? fmtN(gw.position, 1) : "·"}</td>` : na + na + na}</tr>`;
  }).join("");
  const weeks = `<div class="tbl"><table class="weeks">
<thead><tr><th>Тиждень</th><th>Відвідувань</th><th>Нових</th><th>Реєстрацій</th><th>Google кліки</th><th>Покази</th><th>Позиція</th></tr></thead>
<tbody>${weekRows}</tbody></table></div>
<p class="muted small">Крапка — тоді ще не рахували. Google за останні 2–3 дні ще не віддав.</p>`;

  // Google's queries.
  const ctr = (r) => (r.impressions ? `${fmtN((100 * r.clicks) / r.impressions, 1)}%` : "");
  const queries = hasG && g.queries.length ? `<div class="tbl"><table class="refs">
<thead><tr><th>Запит</th><th>Кліки</th><th>Покази</th><th>CTR</th><th>Позиція</th></tr></thead>
<tbody>${g.queries.slice(0, 25).map((r) => `<tr><th>${esc(r.keys[0])}</th><td>${n(r.clicks)}</td><td>${n(r.impressions)}</td><td>${ctr(r)}</td><td>${fmtN(r.position, 1)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">${g?.error ? `Не вдалося взяти дані з Google: ${esc(g.error)}` : gscOn ? "Дані з Google ще завантажуються." : "Google Search Console не підключено (секрет GSC_KEY)."}</p>`;

  // Pages people land on: Google's clicks and impressions next to arrivals from any search engine or AI chat.
  const pages = new Map();
  for (const r of hasG ? g.pages : []) pages.set(pathOf(r.keys[0]), { path: pathOf(r.keys[0]), g: r, ours: 0 });
  for (const l of a.landings) {
    const x = pages.get(l.landing) || { path: l.landing, g: null, ours: 0 };
    x.ours = l.month;
    pages.set(l.landing, x);
  }
  const pageRows = [...pages.values()]
    .sort((x, y) => (y.g?.clicks || 0) + y.ours - ((x.g?.clicks || 0) + x.ours) || (y.g?.impressions || 0) - (x.g?.impressions || 0))
    .slice(0, 30)
    .map((x) => `<tr><th><a href="${esc(x.path)}">${esc(x.path.length > 64 ? x.path.slice(0, 64) + "…" : x.path)}</a></th>${x.g ? `<td>${n(x.g.clicks)}</td><td>${n(x.g.impressions)}</td><td>${fmtN(x.g.position, 1)}</td>` : `<td class="na">·</td><td class="na">·</td><td class="na">·</td>`}<td>${n(x.ours)}</td></tr>`)
    .join("");
  const landings = pages.size ? `<div class="tbl"><table class="urls">
<thead><tr><th>Сторінка</th><th>Google кліки</th><th>Покази</th><th>Позиція</th><th>З пошуку й AI</th></tr></thead>
<tbody>${pageRows}</tbody></table></div>
<p class="muted small">«З пошуку й AI» — наш лічильник: приходи з усіх пошуковиків і AI-чатів за 28 днів. Крапка — Google сторінку не показував.</p>` : "";

  return `${tiles}

<h2 id="sources">Звідки приходять</h2>
${sources}

<h2>По тижнях</h2>
${weeks}

<h2 id="google">Що шукають у Google</h2>
${queries}

${landings ? `<h2>На які сторінки приходять з пошуку</h2>\n${landings}` : ""}

${guestSteps(a.guests)}`;
}

// «Що роблять гості»: of the guests who came in 28 days, how many went on to a second page, tapped «Хочу прочитати»
// (and so the sign-in page), signed up, opened a free book or took its EPUB. From search and AI chats, and the rest.
// Names for /admin/traffic «Що натискають»: the blocks (data-block in pages.js) and what a tap led to (app.js).
const BLOCK_NAMES = { acts: "Кнопки книжки", where: "Де взяти", twins: "Інші мови", series: "Серія", readers: "У читачів", lists: "У списках", about: "Про книжку", reviews: "Відгуки в інтернеті", advice: "Чи варто читати", "author-about": "Про автора", also: "Читали це, сподобалось і це", "in-genre": "Ще в жанрі", fresh: "Нове", pick: "Книжка навмання", kicker: "Жанр", byline: "Автор, рік", search: "Результати пошуку", picks: "Читачі радять", "for-you": "Для вас", finish: "Дочитують до кінця", ua: "Українські автори", short: "Коротке", wanted: "Найбільше хочуть", free: "Безкоштовно", editorials: "Добірки", genres: "Жанри", chips: "Фільтри", header: "Шапка", join: "Смуга «Доєднатися»", footer: "Низ сторінки", "-": "Решта сторінки" };
const TARGET_NAMES = { book: "книжка", author: "автор", genre: "жанр", list: "список", lists: "списки", reader: "читач", publishers: "видавництво", search: "пошук", home: "головна", want: "«Хочу прочитати»", read: "«Прочитано»", reading: "«Читаю»", now: "«Читаю зараз»", kids: "дитяча полиця", remove: "прибрати з полиці", stars: "оцінка зірками", menu: "меню ⋯", open: "розгорнути", button: "кнопка", login: "увійти / доєднатися", "guest:want": "«Хочу прочитати» гостем → вхід", "guest:read": "«Прочитано» гостем → вхід", "guest:now": "«Читаю зараз» гостем → вхід", "guest:kids": "дитяча полиця гостем → вхід", "go:read": "читати безкоштовно", "go:epub": "завантажити EPUB", "reader-app": "Читалка", me: "своя полиця", add: "додати книжки", community: "спільнота", updates: "що нового", privacy: "приватність", mail: "написати нам" };
const targetName = (t) => TARGET_NAMES[t] || (t.startsWith("out:") ? `↗ ${t.slice(4)}` : t.startsWith("form:") ? `форма ${t.slice(5)}` : t);
// «Що натискають»: per part of the site, what was tapped and where, with taps per 100 page views; the search
// results apart (they open on any page), and where in a row the tapped book stood.
function tapsBlock(t) {
  if (!t) return "";
  const head = `<h2 id="taps">Що натискають</h2>`;
  if (!t.rows.length) return `${head}\n<p class="muted small">Рахуємо з ${t.started ? short(t.started) : "сьогодні"}, поки порожньо.</p>`;
  const groups = new Map();
  for (const r of t.rows) {
    const key = r.block === "search" ? "search" : r.page;
    const g = groups.get(key) || { key, name: key === "search" ? "Результати пошуку (на будь-якій сторінці)" : t.names[key] || key, views: key === "search" ? 0 : t.views[key] || 0, total: 0, rows: new Map(), pos: {} };
    groups.set(key, g);
    const id = `${key === "search" ? "" : r.block}|${r.target}`;
    const x = g.rows.get(id) || { block: key === "search" ? "" : r.block, target: r.target, guests: 0, readers: 0 };
    g.rows.set(id, x);
    x.guests += r.guests;
    x.readers += r.readers;
    g.total += r.guests + r.readers;
    if (r.target === "book" && r.pos) g.pos[r.pos] = (g.pos[r.pos] || 0) + r.guests + r.readers;
  }
  const per100 = (v, views) => (views ? fmtN((100 * v) / views, 1) : "");
  const posLine = (pos) => {
    const all = Object.values(pos).reduce((a, b) => a + b, 0);
    return all >= 5 ? `<p class="muted small">Книжка, на яку натиснули, стояла в ряду: ${["1", "2", "3", "4-6", "7-10", "11+"].filter((k) => pos[k]).map((k) => `${k.replace("-", "–")}-а ${fmtN((100 * pos[k]) / all, 0)}%`).join(", ")}.</p>` : "";
  };
  const html = [...groups.values()].sort((a, b) => b.total - a.total).map((g) => {
    const rows = [...g.rows.values()].sort((a, b) => b.guests + b.readers - a.guests - a.readers).slice(0, 12);
    return `<h3>${esc(g.name)} <span class="muted small">· ${n(g.total)} натискань${g.views ? `, ${n(g.views)} переглядів` : ""}</span></h3>
<div class="tbl"><table class="refs"><thead><tr>${g.key === "search" ? "" : "<th>Де</th>"}<th>Що</th><th>Гості</th><th>Читачі</th>${g.views ? "<th>На 100 переглядів</th>" : ""}</tr></thead>
<tbody>${rows.map((x) => `<tr>${g.key === "search" ? "" : `<td>${esc(BLOCK_NAMES[x.block] || x.block)}</td>`}<td>${esc(targetName(x.target))}</td><td>${n(x.guests)}</td><td>${n(x.readers)}</td>${g.views ? `<td>${per100(x.guests + x.readers, g.views)}</td>` : ""}</tr>`).join("")}</tbody></table></div>
${posLine(g.pos)}`;
  }).join("\n");
  return `${head}
<p class="muted small">За 30 днів, рахуємо з ${short(t.since)}. Лише числа: розділ сайту, блок, що натиснули; без людей і адрес. Перегляди — сторінки цього розділу за той самий час.</p>
${html}`;
}

// «Вхід» on /admin: the sign-in page opened (and why), the address given, the code typed, the new account made.
function loginBlock(ev) {
  if (!ev) return "";
  const by = Object.fromEntries(ev.map((r) => [r.prop, r.n]));
  const opened = ev.filter((r) => r.prop.startsWith("page:")).reduce((a, r) => a + r.n, 0);
  if (!opened && !by.email) return `<h2>Вхід</h2>\n<p class="muted small">Рахуємо з сьогодні, поки порожньо.</p>`;
  const WHY = { "page:want": "«Хочу прочитати»", "page:read": "«Прочитано»", "page:now": "«Читаю зараз»", "page:kids": "дитяча полиця", "page:menu": "«Увійти» в меню", "page:reader": "з Читалки" };
  const whyName = (k) => WHY[k] || (k.startsWith("page:from:") ? `«Доєднатися» чи посилання: ${(SECTION_NAMES[k.slice(10)] || k.slice(10)).toLowerCase()}` : k.slice(5));
  const why = ev.filter((r) => r.prop.startsWith("page:")).map((r) => `${whyName(r.prop)} ${n(r.n)}`).join(", ");
  const of = (v) => (opened ? ` <span class="muted">${fmtN((100 * (v || 0)) / opened, 0)}%</span>` : "");
  return `<h2>Вхід</h2>
<div class="tbl"><table class="refs"><tbody>
<tr><th>Відкрили сторінку входу</th><td>${n(opened)}</td><td class="muted small">${why}</td></tr>
<tr><th>Ввели пошту</th><td>${n(by.email)}${of(by.email)}</td><td></td></tr>
<tr><th>Ввели код</th><td>${n((by["code:known"] || 0) + (by["code:new"] || 0))}${of((by["code:known"] || 0) + (by["code:new"] || 0))}</td><td class="muted small">знайомих ${n(by["code:known"])}, нових ${n(by["code:new"])}</td></tr>
<tr><th>Зареєструвались</th><td>${n(by.signup)}${of(by.signup)}</td><td></td></tr>
</tbody></table></div>
<p class="muted small">За 30 днів. Відсоток — від тих, хто відкрив сторінку входу.</p>`;
}

// Pages not found and script errors in readers' browsers, for /admin/speed.
function problemsBlock(notFound = [], js = []) {
  const table = (rows, what) => `<div class="tbl"><table class="refs"><thead><tr><th>${what}</th><th>Гості</th><th>Читачі</th></tr></thead><tbody>${rows.slice(0, 25).map((r) => `<tr><td>${esc(r.prop)}</td><td>${n(r.guests)}</td><td>${n(r.readers)}</td></tr>`).join("")}</tbody></table></div>`;
  return `<h2>Не знайшли сторінку</h2>
${notFound.length ? `<p class="muted small">Адреси, що дали 404 людям (не роботам), за 30 днів.</p>\n${table(notFound, "Адреса")}` : `<p class="muted">Поки жодної.</p>`}
<h2>Помилки в браузері</h2>
${js.length ? `<p class="muted small">Помилки JavaScript у читачів і гостей за 30 днів: розділ сайту, повідомлення, файл і рядок.</p>\n${table(js, "Помилка")}` : `<p class="muted">Поки жодної.</p>`}`;
}

function guestSteps(g) {
  if (!g) return "";
  const rows = [["arrive", "Прийшли"], ["second", "Відкрили ще сторінку"], ["want", "Натиснули «Хочу прочитати»"], ["signup", "Зареєструвались"], ["read", "Читати безкоштовно"], ["epub", "Завантажили EPUB"]];
  const cell = (side, k) => {
    const v = g[side][k] || 0;
    const base = g[side].arrive || 0;
    return `<td>${n(v)}${k !== "arrive" && base ? ` <span class="muted">${fmtN((100 * v) / base, 0)}%</span>` : ""}</td>`;
  };
  return `<h2>Що роблять гості</h2>
<div class="tbl"><table class="refs">
<thead><tr><th></th><th>З пошуку й AI</th><th>Інші</th></tr></thead>
<tbody>${rows.map(([k, name]) => `<tr><th>${name}</th>${cell("search", k)}${cell("other", k)}</tr>`).join("")}</tbody></table></div>
<p class="muted small">Відвідування гостей (без акаунта) за 28 днів, рахуємо з ${short(g.since)}. Відсоток — від тих, хто прийшов.</p>`;
}

const cameCell = (c) => (c ? `${esc(c.source)}${c.ref && c.ref.includes("/") ? ` <a class="muted" href="https://${esc(c.ref)}" target="_blank" rel="noopener noreferrer" title="${esc(c.ref)}">↗</a>` : ""}` : `<span class="muted">—</span>`);

const READER_HEAD = `<th>Читач</th><th>Зареєструвався</th><th>Востаннє</th><th>Днів</th><th>Книжок</th><th>Звідки</th><th>Лист</th>`;
const readerRow = (r) => `<tr${r.owner ? ' class="owner"' : ""}>
  <th><a href="/@${esc(r.username)}">${esc(r.name)}</a> <span class="muted">@${esc(r.username)}</span></th>
  <td>${short(r.created)}</td><td>${short(r.last)}</td><td>${n(r.days)}</td><td>${n(r.books)}</td><td>${cameCell(r.came)}</td>
  <td>${r.digest ? "так" : r.email ? "ні" : `<span class="muted">без пошти</span>`}</td>
</tr>`;

// /admin/readers: everyone, with a search by name or username, a books filter, sorting and pages of
// fifty (Max, 2026-10-22: one table of everybody «unwieldy, а що буде коли їх буде пара сотень?»).
const PAGE = 50;
function readersPage({ user, stats: s, layout, q = "", min = 0, sort = "created", page = 1 }) {
  const SORTS = { last: (a, b) => (b.last || "").localeCompare(a.last || "") || a.created.localeCompare(b.created), books: (a, b) => b.books - a.books || a.created.localeCompare(b.created), created: (a, b) => b.created.localeCompare(a.created), days: (a, b) => b.days - a.days || b.created.localeCompare(a.created) };
  if (!SORTS[sort]) sort = "created";
  min = [0, 1, 10].includes(min) ? min : 0;
  q = String(q || "").trim().toLowerCase().slice(0, 60);
  const all = s.readers.filter((r) => r.books >= min && (!q || r.name.toLowerCase().includes(q) || r.username.includes(q))).sort(SORTS[sort]);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  page = Math.min(Math.max(1, Number(page) || 1), pages);
  const shown = all.slice((page - 1) * PAGE, page * PAGE);
  const url = ({ books = min, by = sort, p = 1, query = q } = {}) => `/admin/readers${[query ? `q=${encodeURIComponent(query)}` : "", books ? `books=${books}` : "", by !== "created" ? `sort=${by}` : "", p > 1 ? `page=${p}` : ""].filter(Boolean).map((x, i) => (i ? "&" : "?") + x).join("")}`;
  const col = (key, label) => (sort === key ? `<th class="sorted">${label} ↓</th>` : `<th><a href="${url({ by: key })}" title="Відсортувати">${label}</a></th>`);
  const filters = [[0, "Усі"], [1, "1+ книжка"], [10, "10+ книжок"]].map(([k, l]) => { const c = s.readers.filter((r) => r.books >= k).length; return k === min ? `<b>${l} (${c})</b>` : `<a href="${url({ books: k })}">${l} (${c})</a>`; }).join(" · ");
  const pager = pages > 1 ? `<p class="filter pager">${[...Array(pages)].map((_, i) => (i + 1 === page ? `<b>${i + 1}</b>` : `<a href="${url({ p: i + 1 })}">${i + 1}</a>`)).join(" ")}</p>` : "";
  const body = `<section class="admin">
<section class="page-head"><div><h1>Читачі</h1><p class="sub">«Днів» — скільки різних днів читач був на сайті після реєстрації. Заголовки сортують таблицю.</p></div></section>
<form class="find admin-find" action="/admin/readers" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="ім'я або нікнейм" autocomplete="off" aria-label="Пошук читача">${min ? `<input type="hidden" name="books" value="${min}">` : ""}${sort !== "created" ? `<input type="hidden" name="sort" value="${sort}">` : ""}</form>
<p class="filter">${filters}${q ? ` · знайдено ${all.length} <a href="${url({ query: "" })}">скинути пошук</a>` : ""}</p>
${pager}
${shown.length ? `<div class="tbl"><table class="readers">
<thead><tr><th>Читач</th>${col("created", "Зареєструвався")}${col("last", "Востаннє")}${col("days", "Днів")}${col("books", "Книжок")}<th>Звідки</th><th>Лист</th></tr></thead>
<tbody>${shown.map(readerRow).join("")}</tbody></table></div>` : `<p class="muted">Нікого не знайдено.</p>`}
${pager}
</section>`;
  return layout({ title: "Читачі · Адмінка", user, path: "/admin", body });
}

// The catalog's size and how fast it grows (store.catalogStats; Max, 2026-10-25). Days start 2026-10-25.
function catalogBlock(c, full = false) {
  if (!c) return "";
  const days = Object.keys(c.daily).sort();
  const at = (back) => {
    const d = addDays(days[days.length - 1] || "", -back);
    const k = days.filter((x) => x <= d).pop();
    return k ? c.daily[k].works : null;
  };
  const growth = (back) => {
    const was = at(back);
    if (was === null || !days.length) return "";
    const d = c.works - was;
    return d < 0 ? `−${-d}` : `+${d}`;
  };
  const rows = days
    .slice(-14)
    .reverse()
    .map((d) => {
      const i = days.indexOf(d);
      const prev = i > 0 ? c.daily[days[i - 1]] : null;
      const x = c.daily[d];
      return `<tr><th>${short(d)}</th><td>${x.works}</td><td>${prev ? n(x.works - prev.works) : "·"}</td><td>${x.items}</td><td>${x.draft ? x.draft : n(0)}</td></tr>`;
    })
    .join("");
  const shelves = [...c.shelves]
    .sort((a, b) => b.works - a.works)
    .map((s) => `<tr><th style="white-space:normal">${s.name}${s.draft ? ' <em>чернетка</em>' : ""}</th><td>${s.works}</td><td>${s.items}</td></tr>`)
    .join("");
  const since = days.length ? `рахуємо з ${short(days[0])}` : "";
  const tiles = `<div class="stats">${tile(c.works, "книжок у каталогі", `${c.items} видань на ${c.shelves.filter((s) => !s.draft).length} полицях${c.draft ? `, ${c.draft} у чернетках` : ""}`)}${tile(growth(7) || "—", "за 7 днів", growth(7) ? (growth(1) ? `${growth(1)} за добу` : "") : since)}${tile(growth(28) || "—", "за 28 днів", growth(28) ? "" : since)}</div>`;
  // On /admin only the summary, the tables on /admin/shelves (Max, 2026-10-25: like «Нові читачі»).
  if (!full) return tiles;
  return `<section class="admin">
<section class="page-head"><div><p class="crumbs"><a href="/admin/catalog">Каталог</a></p><h1>Полиці</h1><p class="sub">Книжка — один твір з усіма виданнями (папір, e-book, аудіо, різні видавництва). Чернетки бачиш лише ти; книжки, які є й на відкритих полицях, у чернетках не рахуються. Рахується з 25 жовтня.</p></div></section>
${tiles}
<h2>По днях</h2>
<div class="tbl"><table>
<thead><tr><th>День</th><th>Книжок</th><th>За день</th><th>Видань</th><th>У чернетках</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>По полицях</h2>
<div class="tbl"><table>
<thead><tr><th>Полиця</th><th>Книжок</th><th>Видань</th></tr></thead>
<tbody>${shelves}</tbody></table></div>
</section>`;
}
function shelvesPage({ user, catalog, layout }) {
  return layout({ title: "Полиці · Адмінка", user, path: "/admin", body: catalogBlock(catalog, true) });
}

function adminPage({ user, stats: s, overviews: o = null, catalog = null, gsc = null, gscOn = false, taps = null, login = null, layout, page = "main" }) {
  const traffic = page === "traffic";
  const t = s.totals;
  const tiles = [
    tile(t.readers, "читачів", `+${t.signupsWeek} за тиждень, +${t.signupsMonth} за місяць`),
    tile(t.activeWeek, "активних за 7 днів", `${t.returningWeek} повернулись, ${t.activeToday} сьогодні`),
    tile(t.activeMonth, "активних за 28 днів", t.readers ? `${Math.round((100 * t.activeMonth) / t.readers)}% усіх читачів` : ""),
    tile(t.entries, "книжок на полицях", `+${t.entriesWeek} за тиждень · ${t.want} у «хочу прочитати»`),
    tile(t.ratings, "оцінок", `${t.notes} нотаток`),
    tile(t.follows, "стежень", `${t.digestOn} підписані на лист, ${t.digestOff} відписались`),
  ].join("");

  // Newest week on top in both tables (Max, 2026-10-20: «свіжі зверху», «починаємо з цього тижня»).
  const weekRows = [...s.weeks]
    .reverse()
    .map(
      (w) => `<tr${w.current ? ' class="now"' : ""}>
  <th>${weekLabel(w.week)}${w.current ? ' <em>зараз</em>' : ""}</th>
  <td>${n(w.signups)}</td><td>${n(w.active)}</td><td>${n(w.returning)}</td><td>${n(w.books)}</td><td>${n(w.ratings)}</td><td>${n(w.notes)}</td><td>${n(w.follows)}</td><td>${n(w.digest)}</td>
  <td>${w.views.tracked ? `${w.views.readers} <span class="muted">/ ${w.views.guests}</span>` : `<span class="na">·</span>`}</td>
</tr>`
    )
    .join("");

  const cohortRows = [...s.cohorts]
    .reverse()
    .map((c) => `<tr><th>${weekLabel(c.week)}</th><td>${c.size}</td>${c.later.map(pct).join("")}</tr>`)
    .join("");

  // /admin is about readers and retention, /admin/traffic about where visitors come from (Max, 2026-10-24).
  const body = traffic
    ? `<section class="admin">
<section class="page-head"><div><h1>Трафік</h1></div></section>

${trafficBody(s, gsc, gscOn)}

${tapsBlock(taps)}

<h2>Перегляди за розділами</h2>
<p class="muted small">Скільки сторінок кожного розділу відкрили (читачі й гості разом, без ботів). Рахується з ${s.sections.length ? "22 жовтня" : "сьогодні"}; які саме сторінки, не зберігаємо.</p>
${s.sections.length ? `<div class="tbl"><table class="sections">
<thead><tr><th>Розділ</th><th>Сьогодні</th><th>7 днів</th><th>28 днів</th></tr></thead>
<tbody>${s.sections.map((x) => `<tr><th>${x.name}</th><td>${n(x.today)}</td><td>${n(x.week)}</td><td>${n(x.month)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Поки нічого не нарахувалось.</p>`}

</section>`
    : `<section class="admin">
<section class="page-head"><div><h1>Огляд</h1><p class="sub">Станом на ${short(s.now)}. Активний читач — той, хто відкрив сайт або щось зробив на полиці того дня. Перегляди рахуються з ${s.totals.viewsSince ? short(s.totals.viewsSince) : "сьогодні"}; раніше за активність правлять входи й зміни на полиці.</p></div></section>
<div class="stats">${tiles}</div>

${funnelBlock(s.funnel)}

${loginBlock(login)}

<h2>По тижнях</h2>
<p class="muted small">Читачі без власника. «Повернулись» — активні цього тижня, але зареєстровані раніше. Перегляди: сторінок, відкритих читачами / гостями (без ботів).</p>
<div class="tbl"><table>
<thead><tr><th>Тиждень</th><th>Нові</th><th>Активні</th><th>Повернулись</th><th>Книжок</th><th>Оцінок</th><th>Нотаток</th><th>Стежень</th><th>Листів</th><th>Перегляди</th></tr></thead>
<tbody>${weekRows}</tbody></table></div>

<h2>Retention за когортами</h2>
<p class="muted small">Хто з читачів, що зареєструвались певного тижня, повертався через 1, 2, 3, 4 та 8 тижнів. Крапка — той тиждень ще не настав; бліде число — тиждень ще триває.</p>
${s.cohorts.length ? `<div class="tbl"><table class="cohorts">
<thead><tr><th>Зареєструвались</th><th>Читачів</th>${s.later.map((k) => `<th>+${k} тиж.</th>`).join("")}</tr></thead>
<tbody>${cohortRows}</tbody></table></div>` : `<p class="muted">Поки нема жодної когорти.</p>`}

<p class="muted small">Сесій (пристроїв, що залишились увійшовши): ${t.sessions}.</p>
</section>`;
  return layout({ title: traffic ? "Трафік · Адмінка" : "Адмінка", user, path: "/admin", body });
}

// /admin/overviews: every overview with readers' 🤩/🙂/🙁, the complained-about ones on top.
function overviewsPage({ user, list, stats: o, who, layout }) {
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = list
    .map((r) => {
      const by = who(r.by);
      const notes = (r.complaints || []).filter((c) => c.note).map((c) => { const w = who(c.reader); return `<div class="muted" style="white-space:normal;max-width:520px;margin-top:4px">🙁 ${w ? `<a href="${esc(w.href)}">${esc(w.name)}</a>: ` : ""}${esc(c.note)}</div>`; }).join("");
      const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
      const found = r.queries?.length || r.sources?.length ? `<details style="margin-top:4px"><summary class="muted" style="cursor:pointer">запити ${r.queries?.length || 0}, джерела ${r.sources?.length || 0}</summary><div class="muted" style="white-space:normal;max-width:520px">${(r.queries || []).map((q) => `🔍 ${esc(q)}`).join("<br>")}${r.queries?.length ? "<br>" : ""}${(r.sources || []).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.title)}">${esc(host(x.url))}</a>`).join(" · ")}</div></details>` : "";
      return `<tr${r.down ? ' class="now"' : ""}><td><a href="${esc(r.book.href)}">${esc(r.book.title)}</a> <span class="muted">${esc(r.book.author || "")}</span>${notes}${found}</td><td>${r.up || ""}</td><td>${r.mid || ""}</td><td>${r.down || ""}</td><td>${r.created.slice(0, 16).replace("T", " ")}</td><td>${by ? `<a href="${esc(by.href)}">${esc(by.name)}</a>` : r.by === "auto" ? "сам" : r.by === "redo" ? "перероблено" : ""}</td><td>${n(r.searches)}</td><td>${n(r.input_tokens)}</td><td>${n(r.output_tokens)}</td></tr>`;
    })
    .join("\n");
  const body = `<section class="admin">
<p class="crumbs"><a href="/admin/catalog">Каталог</a></p>
<h1>Огляди від Claude</h1>
<p>${n(o.n)} оглядів, ${o.auto} зроблені самі · 🤩 ${o.up} · 🙂 ${o.mid} · 🙁 ${o.down} · ${o.queue} в черзі · ≈ $${o.cost.toFixed(2)} за весь час</p>
<p class="muted"><a href="/admin/overviews-trial">Проба нового промпту</a> · Поточна версія промпту ${o.version}: ${o.current} з ${o.n} · невдалих після рестарту: ${o.failed}${o.lastError ? ` · остання помилка: ${esc(o.lastError)}` : ""}</p>
<table><thead><tr><th>Книжка</th><th>🤩</th><th>🙂</th><th>🙁</th><th>Коли</th><th>Хто</th><th>Пошуків</th><th>Токенів in</th><th>out</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
  return layout({ title: "Огляди від Claude · Адмінка", user, path: "/admin", body });
}

// /admin/speed (speed.js): how fast the site is, day by day.
function speedPage({ user, days, bots = [], notFound = [], jsErrors = [], layout }) {
  const { EDGES } = require("./speed");
  const s = (ms) => (ms == null ? "" : ms === Infinity ? `> ${EDGES[EDGES.length - 1] / 1000} с` : `${String(ms / 1000).replace(".", ",")} с`);
  const pct = (x) => (x == null ? "" : `${String(Math.round(x * 1000) / 10).replace(".", ",")}%`);
  const short = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const cell = (k) => (k ? `<td>${s(k.median)}</td><td>${s(k.p95)}</td><td>${pct(k.slow)}</td><td class="muted">${n(k.n)}</td>` : `<td></td><td></td><td></td><td></td>`);
  const rows = [...days].map(([d, k]) => `<tr><th>${short(d)}</th>${cell(k.page)}${cell(k.phone)}<td>${k.stall ? `${Math.round(k.stall.sum / 1000)} с` : "0"}</td><td class="muted">${k.bot ? n(k.bot.n) : ""}</td></tr>`).join("");
  const body = `<section class="admin speed">
<section class="page-head"><div><h1>Швидкість сайту</h1><p class="sub">Скільки сервер думав над сторінкою і за скільки вона відкрилась у браузері читача. Тільки числа за день, без адрес і людей.</p></div></section>

<h2>По днях</h2>
${days.size ? `<div class="tbl"><table>
<thead><tr><th rowspan="2">День</th><th colspan="4">Сервер: сторінки для людей</th><th colspan="4">Браузер на телефоні: сторінка відкрилась</th><th rowspan="2">Сервер стояв</th><th rowspan="2">Роботам</th></tr>
<tr><th>Медіана</th><th>95%</th><th>&gt; 2 с</th><th>Скільки</th><th>Медіана</th><th>95%</th><th>&gt; 2 с</th><th>Скільки</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="muted small">Медіана й 95% — верхня межа кошика (до 0,1 / 0,2 / 0,5 / 1 / 2 / 5 / 10 с): «95% за 0,2 с» значить, що 95 сторінок зі 100 сервер віддав швидше за 0,2 с.</p>` : `<p class="muted">Рахуємо з сьогодні; перші числа з'являться за хвилину після першої сторінки.</p>`}

<h2>Роботи за 7 днів</h2>
${bots.length ? `<p class="muted small">Усі запити роботів (сторінки, обкладинки, файли), за назвою з їхнього User-Agent. «Час сервера» — скільки секунд сервер на них витратив; «503» — скільки разів ми попросили прийти пізніше, бо сайт був зайнятий.</p>
<div class="tbl"><table>
<thead><tr><th>Робот</th><th>Запитів</th><th>З них сторінок</th><th>Час сервера</th><th>503</th><th>Сьогодні</th></tr></thead>
<tbody>${bots.map((r) => `<tr><th>${esc(r.name)}</th><td>${n(r.n)}</td><td>${n(r.pages)}</td><td>${n(Math.round(r.ms / 1000))} с</td><td>${n(r.turned)}</td><td>${n(r.today)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Рахуємо з сьогодні.</p>`}
${problemsBlock(notFound, jsErrors)}
</section>`;
  return layout({ title: "Швидкість · Адмінка", user, path: "/admin", body });
}

// /admin/jobs (Max, 2026-10-26: «сторінку про ці background tasks»): what the jobs process (jobs.js) does
// on its own: the schedules, what runs now, and every run of the last month with how long it took and how it went.
const JOBS = {
  "refresh.run": "Оновлення полиць магазинів і бібліотек",
  "wikidata.run": "Wikidata: українські назви, автори, деталі книжок",
  "readeat.run": "Readeat: деталі книжок",
  "enrich.run": "Open Library: деталі книжок",
  "ol-covers.run": "Обкладинки з Open Library до себе",
  "covers.run": "Обкладинки з Goodreads і за ISBN",
  "thumbs-warm": "Малі обкладинки для полиць читачів",
  "thumbs-prune": "Прибрати зайві малі обкладинки",
  "freeBooks.run": "Вільні книжки з «Хочу прочитати»",
  "genreTrial.run": "Жанри: проба на 200",
  "genreTrial.runAll": "Жанри: весь каталог і нові книжки",
  "origTrial.run": "Оригінали: проба на 200",
  "origTrial.runAll": "Оригінали: весь каталог і нові книжки",
  "langTrial.run": "Мова: проба на 200",
  "langTrial.runAll": "Мова: весь каталог і нові книжки",
  "ukTrial.run": "Переклади: проба",
  "advice.sweep": "Відгуки в інтернеті: книжки в чергу",
  "advice.redo": "Відгуки в інтернеті: переробити за новим промптом",
  "gsc.run": "Google Search Console",
  "newBooks.run": "Нові книжки: перевірки",
  "ukrlib.run": "Укрліб: лінки на класику",
};
const PASSES = { dupes: "Дублі", notbooks: "Не книжки", series: "Серії", year: "Рік прочитання", authors: "Автори", covers: "Обкладинки", mentions: "Згадки", blurb: "Опис" };
const jobName = (job) => {
  if (JOBS[job]) return JOBS[job];
  const m = /^pass:(\w+)\.(run|runAll)$/.exec(job);
  if (m) return `${PASSES[m[1]] || m[1]}: ${m[2] === "run" ? "проба" : "весь каталог і нові книжки"}`;
  return job;
};
// Schedule -> the jobs it starts (their runs are written down under the job's name).
const PLANS = {
  newbooks: { what: "Нові книжки: перевірки", note: "кожні 3 хв, коли є черга", jobs: ["newBooks.run"] },
  "refresh-check": { what: "Оновлення полиць", note: "перевіряє кожні 10 хв, оновлює раз на 20 год", jobs: ["refresh.run"] },
  wikidata: { what: "Wikidata, автори, деталі книжок", jobs: ["wikidata.run"] },
  "ol-covers": { what: "Обкладинки з Open Library", jobs: ["ol-covers.run"] },
  covers: { what: "Обкладинки з Goodreads і за ISBN", jobs: ["covers.run"] },
  "thumbs-warm": { what: "Малі обкладинки для полиць", jobs: ["thumbs-warm"] },
  "thumbs-prune": { what: "Прибрати зайві малі обкладинки", jobs: ["thumbs-prune"] },
  free: { what: "Вільні книжки з «Хочу прочитати»", jobs: ["freeBooks.run"] },
  ukrlib: { what: "Укрліб: лінки на класику", note: "сайт читає один раз, з нашим каталогом звіряє щодня", jobs: ["ukrlib.run"] },
  aipasses: { what: "Haiku: нові книжки (жанри, мова, оригінали, дублі…)", jobs: ["genreTrial.runAll", "origTrial.runAll", "langTrial.runAll", /^pass:\w+\.runAll$/] },
  gsc: { what: "Google Search Console", jobs: ["gsc.run"] },
  overviews: { what: "Відгуки в інтернеті: книжки в чергу", jobs: ["advice.sweep"] },
};
const fits = (job, keys) => keys.some((k) => (k instanceof RegExp ? k.test(job) : k === job));

// Where a new book came from (store.js source), for the queue on /admin/jobs.
const FROM = { catalog: "каталог", manual: "вручну", goodreads: "Goodreads", "apple-books": "Apple Books", list: "список", chat: "чат", tip: "українське видання" };
const STEPS = { lang: "мова", genre: "жанри", orig: "переклад?", details: "деталі" };
const ANSWERS = { uk: "українська", ru: "російська", en: "англійська", other: "інша", unknown: "не знає", translation: "так", ukrainian: "ні, українська" };

function jobsPage({ user, layout, o, queue, book = () => null, href = () => "#", digest, wantMail, now = new Date() }) {
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const kyiv = (iso, day = true) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const time = d.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "short" });
    const today = now.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "short" });
    return day && date !== today ? `${date}, ${time}` : `${time}`;
  };
  const dur = (ms) => {
    if (ms == null) return "";
    if (ms < 10000) return `${String(Math.round(ms / 100) / 10).replace(".", ",")} с`;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} с`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} хв`;
    return `${Math.floor(min / 60)} год${min % 60 ? ` ${min % 60} хв` : ""}`;
  };
  const often = (ms) => (ms % (3600 * 1000) ? `кожні ${ms / 60000} хв` : ms === 24 * 3600 * 1000 ? "раз на добу" : `кожні ${ms / 3600000} год`);
  const result = (r) => (!r ? "" : `${["<span class=\"bad\">✗</span>", "<span class=\"ok\">✓</span>", "<span class=\"warn\">⚠</span>"][r.ok]} ${esc(r.note)}`);
  const ago = (iso) => {
    const ms = Date.parse(iso) - now;
    if (ms <= 60000) return "зараз";
    return ms > 24 * 3600 * 1000 ? kyiv(iso) : `через ${dur(ms)}`;
  };
  const live = o.live || {};
  const proc = live["@"] || {};
  const runningNow = [
    ...Object.entries(live)
      .filter(([k, v]) => k !== "@" && (v.running || v.allRunning))
      .map(([k, v]) => (k === "advice" ? "Відгуки в інтернеті: огляди" : jobName(`${k}.${v.allRunning ? "runAll" : "run"}`))),
    ...(proc.sched || []).filter((name) => !PLANS[name]?.jobs.some((j) => typeof j === "string" && live[j.split(".")[0]]?.running)).map((name) => PLANS[name]?.what || name),
  ];
  const queued = live.advice?.queued || 0;
  const lastOf = (keys) => o.last.filter((r) => fits(r.job, keys)).sort((a, b) => b.started.localeCompare(a.started))[0];
  const countOf = (keys) => o.counts.filter((c) => fits(c.job, keys)).reduce((t, c) => ({ n: t.n + c.n, failed: t.failed + c.failed }), { n: 0, failed: 0 });
  const week = o.counts.reduce((t, c) => ({ n: t.n + c.n, failed: t.failed + c.failed }), { n: 0, failed: 0 });
  const seven = (c) => (c.n ? `${c.n}${c.failed ? ` <span class="bad">(${c.failed} ✗)</span>` : ""}` : `<span class="zero">0</span>`);

  const plans = o.plans.map((p) => {
    const plan = PLANS[p.name] || { what: p.name, jobs: [p.name] };
    const r = lastOf(plan.jobs);
    const next = p.last ? new Date(Date.parse(p.last) + p.ms).toISOString() : null;
    return `<tr><th>${esc(plan.what)}<small>${plan.note || often(p.ms)} · перевірка ${kyiv(p.last)}</small></th><td>${r ? kyiv(r.started) : "—"}</td><td>${r ? dur(r.ms) : ""}</td><td class="res">${result(r)}</td><td>${seven(countOf(plan.jobs))}</td><td>${next ? ago(next) : "після старту"}</td></tr>`;
  });
  // The letters keep their own schedule and their last run in meta (digest.js, wantmail.js).
  const nextAt = (dayOfWeek, hour) => {
    const k = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    const t = new Date(k);
    t.setHours(hour, 0, 0, 0);
    while ((dayOfWeek != null && t.getDay() !== dayOfWeek) || t <= k) t.setDate(t.getDate() + 1);
    return new Date(now.getTime() + (t - k)).toISOString();
  };
  const letter = (what, often, last, next) => `<tr><th>${what}<small>${often}</small></th><td>${kyiv(last?.started)}</td><td>${last?.finished ? dur(Date.parse(last.finished) - Date.parse(last.started)) : last ? "іде" : ""}</td><td class="res">${last ? `${last.errors?.length ? `<span class="bad">✗</span> помилок ${last.errors.length}: ${esc(String(last.errors[0]?.message || last.errors[0]).slice(0, 120))}, ` : `<span class="ok">✓</span> `}надіслано ${last.sent || 0}` : ""}</td><td></td><td>${ago(next)}</td></tr>`;
  plans.push(letter("Щотижневий лист", "щоп'ятниці о 9:00", digest, nextAt(5, 9)));
  plans.push(letter("Лист «з вашого «Хочу» тепер є»", "щодня о 10:00", wantMail, nextAt(null, 10)));

  const planned = Object.values(PLANS).flatMap((p) => p.jobs);
  const others = o.last.filter((r) => !fits(r.job, planned)).sort((a, b) => b.started.localeCompare(a.started));
  const how = (h) => (h === "розклад" ? "за розкладом" : h === "сайт" ? "з адмінки чи сайту" : "після старту");
  const recent = o.recent.map((r) => `<tr><td>${kyiv(r.started)}</td><th>${esc(jobName(r.job))}</th><td class="muted">${how(r.how)}</td><td>${dur(r.ms)}</td><td class="res">${result(r)}</td></tr>`).join("");

  const q = queue || { waiting: 0, day: {}, week: {}, bySource: [], latest: [] };
  const money = (x) => `$${(x || 0).toFixed(3)}`;
  const found = (st) => {
    if (st.gone) return `<span class="muted">злита з іншою чи видалена</span>`;
    const parts = Object.entries(STEPS).filter(([k]) => st[k]).map(([k, name]) => (String(st[k]).startsWith("✗") ? `<span class="bad">${name} ${esc(st[k])}</span>` : `${name}: ${esc(ANSWERS[st[k]] || st[k])}`));
    if (st.ru) parts.push(`<span class="warn">російська, схована</span>`);
    if (st.work) parts.push(`<span class="muted">видання книжки <a href="${href(st.work)}">${esc(book(st.work)?.title || st.work)}</a></span>`);
    return parts.join(" · ") || `<span class="muted">нічого не треба було</span>`;
  };
  const queueBlock = `<h2>Нові книжки</h2>
<p class="muted small">Кожна нова книжка, від читача чи з каталогу, стає в чергу, і за кілька хвилин її перевіряють: деталі й обкладинка, мова (російську ховаємо), жанри, оригінал, дублі, обкладинка до себе. До ${require("./newbooks").DAILY} книжок на день.</p>
<div class="stats four">
  <div class="stat"><b>${q.waiting}</b>чекають${q.oldest ? `, найдовше з ${kyiv(q.oldest)}` : ""}</div>
  <div class="stat"><b>${q.day.n || 0}</b>перевірено за добу${q.day.failed ? `, <span class="bad">${q.day.failed} з помилкою</span>` : ""}</div>
  <div class="stat"><b>${q.week.n || 0}</b>за 7 днів${q.bySource.length ? `: ${q.bySource.map((x) => `${FROM[x.source] || esc(x.source)} ${x.n}`).join(", ")}` : ""}</div>
  <div class="stat"><b>${money(q.week.cost)}</b>Haiku за 7 днів</div>
</div>
${q.latest.length ? `<div class="tbl"><table>
<thead><tr><th>Книжка</th><th>Звідки</th><th>Додано</th><th>Перевірено</th><th>Що знайшли</th></tr></thead>
<tbody>${q.latest.map((r) => `<tr><th><a href="${href(r.id)}">${esc(book(r.id)?.title || r.id)}</a></th><td class="muted">${FROM[r.source] || esc(r.source)}</td><td>${kyiv(r.added)}</td><td>${kyiv(r.done)}</td><td class="res">${found(r.steps)}</td></tr>`).join("")}</tbody></table></div>` : ""}
`;

  const body = `<section class="admin jobs">
<section class="page-head"><div><h1>Фонові задачі</h1><p class="sub">Окремий процес поруч із сайтом: оновлює полиці, питає Haiku й Claude, шле листи. Сайт від нього не гальмує, а коли задача змінила книжки, сайт сам перечитує дані. Час київський, записи за 30 днів.</p></div></section>
<div class="stats four">
  <div class="stat"><b>${o.role === "web" ? (proc.born ? kyiv(proc.born) : "—") : "в одному процесі"}</b>${o.role === "web" ? `процес задач запущено${proc.mb ? `, ${proc.mb} МБ пам'яті` : ""}` : "сайт і задачі разом (локальний запуск)"}</div>
  <div class="stat"><b>${runningNow.length}</b>${runningNow.length ? `іде зараз: ${esc(runningNow.join(", "))}` : "зараз нічого не йде"}</div>
  <div class="stat"><b>${queued}</b>книжок чекають на «Відгуки в інтернеті»${live.advice?.capped ? " (на сьогодні ліміт 150 вичерпано)" : ""}</div>
  <div class="stat"><b>${week.n}${week.failed ? ` / <span class="bad">${week.failed} ✗</span>` : ""}</b>запусків за 7 днів${week.failed ? ", з них невдалих" : ""}</div>
</div>

${queueBlock}
<h2>За розкладом</h2>
<div class="tbl"><table>
<thead><tr><th>Задача</th><th>Остання робота</th><th>Тривала</th><th>Як пройшла</th><th>7 днів</th><th>Наступна</th></tr></thead>
<tbody>${plans.join("")}</tbody></table></div>
<p class="muted small">«Перевірка» — коли розклад востаннє будив задачу; «Остання робота» — коли вона справді щось робила (якщо нічого не знайшла, не пишемо). Після рестарту процесу задачі чекають 1–30 хв, поки сайт розігріється.</p>

${others.length ? `<h2>Інші задачі</h2>
<p class="muted small">Ті, що запускаються з адмінки, або продовжуються самі після рестарту.</p>
<div class="tbl"><table>
<thead><tr><th>Задача</th><th>Остання</th><th>Хто запустив</th><th>Тривала</th><th>Як пройшла</th><th>7 днів</th></tr></thead>
<tbody>${others.map((r) => `<tr><th>${esc(jobName(r.job))}</th><td>${kyiv(r.started)}</td><td class="muted">${how(r.how)}</td><td>${dur(r.ms)}</td><td class="res">${result(r)}</td><td>${seven(countOf([r.job]))}</td></tr>`).join("")}</tbody></table></div>` : ""}

<h2>Останні запуски</h2>
${recent ? `<div class="tbl"><table>
<thead><tr><th>Коли</th><th>Задача</th><th>Хто запустив</th><th>Тривала</th><th>Як пройшла</th></tr></thead>
<tbody>${recent}</tbody></table></div>` : `<p class="muted">Записуємо з сьогодні: перші рядки з'являться після першої задачі.</p>`}
<p class="small"><a class="text-link" href="/admin/refresh">Оновити каталоги зараз</a> · <a class="text-link" href="/refresh-status">стан каталогів</a> · <a class="text-link" href="/digest/status">стан розсилки</a></p>
</section>`;
  return layout({ title: "Фонові задачі · Адмінка", user, path: "/admin", body });
}

module.exports = { BOT, Admin, mailLinks, adminPage, catalogBlock, shelvesPage, readersPage, overviewsPage, speedPage, jobsPage, dayOf, weekOf, sectionOf };
