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
  ["Пошта", "mail", /^mail\.google\.|outlook\.|^mail\.|(^|\.)ukr\.net$|^email$|^digest$|^newsletter$/],
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
    if (BOT.test(req.headers["user-agent"] || "")) return;
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
    if (BOT.test(req.headers["user-agent"] || "") || /prefetch|prerender/i.test(req.headers["sec-purpose"] || req.headers.purpose || "")) return;
    try {
      const referer = req.headers.referer || req.headers.referrer || "";
      const from = sourceOf(referer, req.query, ownHosts);
      const set = [];
      const tail = `; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
      set.push(`chytai_here=1; Max-Age=1800${tail}`);
      const arrival = from && (referer || !cookies.chytai_here);
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
    for (const r of rows) {
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
      const x = (bySource[c.source] ||= { source: c.source, kind: KIND[c.source] || "other", week: 0, weekNew: 0, month: 0, monthNew: 0, signups: 0 });
      x.signups++;
    }
    const top = (m, k = 20) => Object.values(m).sort((a, b) => b.month - a.month || b.week - a.week).slice(0, k);
    return { since, sources: top(bySource, 40), refs: top(byRef), landings: top(byLanding, 15) };
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
function arrivalsDetails(a) {
  if (!a) return "";
  const pair = (v, fresh) => `${n(v)}${v ? ` <span class="muted">/ ${fresh}</span>` : ""}`;
  const link = (ref) => (ref.startsWith("кампанія") ? esc(ref) : `<a href="https://${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref.length > 70 ? ref.slice(0, 70) + "…" : ref)}</a>`);
  const refs = a.refs.map((x) => `<tr><th>${link(x.ref)} <span class="muted">${esc(x.source)}</span></th><td>${pair(x.week, x.weekNew)}</td><td>${pair(x.month, x.monthNew)}</td></tr>`).join("");
  const landings = a.landings.map((x) => `<tr><th><a href="${esc(x.landing)}">${esc(x.landing)}</a></th><td>${n(x.week)}</td><td>${n(x.month)}</td></tr>`).join("");
  return `<h2 id="sources">Звідки приходять</h2>
${sourcesTable(a)}
${a.refs.length ? `<h3>Звідки саме</h3>
<div class="tbl"><table class="refs urls">
<thead><tr><th>Адреса</th><th>7 днів</th><th>28 днів</th></tr></thead>
<tbody>${refs}</tbody></table></div>` : ""}
${a.landings.length ? `<h3>Сторінки з пошуку</h3>
<div class="tbl"><table class="landings urls">
<thead><tr><th>Сторінка</th><th>7 днів</th><th>28 днів</th></tr></thead>
<tbody>${landings}</tbody></table></div>` : ""}`;
}

// Google Search Console (Max, 2026-10-26): what Google shows of the site in its results, fetched once a day
// by gsc.js. The last 28 days with data against the 28 before, by weeks, and the top queries and pages.
function gscBlock(g, configured) {
  const head = `<h2 id="google">Google Пошук</h2>`;
  if (!g || !g.days) {
    const why = g?.error ? `Не вдалося взяти дані: ${esc(g.error)}` : configured ? "Дані ще не завантажились, перше завантаження за кілька хвилин після старту." : "Ще не підключено: потрібен секрет GSC_KEY з ключем сервісного акаунта.";
    return `${head}\n<p class="muted small">${why}</p>`;
  }
  const sum = (rows) => {
    const c = rows.reduce((a, r) => a + r.clicks, 0);
    const i = rows.reduce((a, r) => a + r.impressions, 0);
    return { clicks: c, impressions: i, ctr: i ? (100 * c) / i : 0, position: i ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / i : 0 };
  };
  const now = g.days.filter((d) => d.day >= g.from && d.day <= g.to);
  const before = g.days.filter((d) => d.day >= addDays(g.from, -28) && d.day < g.from);
  const a = sum(now);
  const b = before.length >= 20 ? sum(before) : null;
  const fmt = (v, digits = 0) => v.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const delta = (x, y, digits = 0, unit = "") => {
    if (!b) return "";
    const d = x - y;
    return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d), digits)}${unit} до попередніх 28 днів`;
  };
  const pctOf = (x, y) => (y ? `${x >= y ? "+" : "−"}${Math.round((100 * Math.abs(x - y)) / y)}% до попередніх 28 днів` : "");
  const tiles = `<div class="stats four">${tile(fmt(a.clicks), "кліків", b ? pctOf(a.clicks, b.clicks) : "")}${tile(fmt(a.impressions), "показів", b ? pctOf(a.impressions, b.impressions) : "")}${tile(`${fmt(a.ctr, 1)}%`, "CTR", delta(a.ctr, b?.ctr, 1, " п.п."))}${tile(fmt(a.position, 1), "середня позиція", b ? `${fmt(b.position, 1)} у попередні 28 днів` : "")}</div>`;
  const weeks = new Map();
  for (const d of g.days) {
    const w = weekOf(d.day);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(d);
  }
  const weekRows = [...weeks]
    .sort((x, y) => y[0].localeCompare(x[0]))
    .slice(0, 12)
    .map(([w, rows], i) => {
      const x = sum(rows);
      const part = rows.length < 7;
      if (part && i > 0) return `<tr><th>${weekLabel(w)} <span class="muted">${rows.length} дн.</span></th><td>${n(x.clicks)}</td><td>${n(x.impressions)}</td><td>${x.impressions ? fmt(x.ctr, 1) + "%" : n(0)}</td><td>${x.impressions ? fmt(x.position, 1) : `<span class="na">·</span>`}</td></tr>`;
      return `<tr${part ? ' class="now"' : ""}><th>${weekLabel(w)}${part ? ` <em>${rows.length} дн.</em>` : ""}</th><td>${n(x.clicks)}</td><td>${n(x.impressions)}</td><td>${x.impressions ? fmt(x.ctr, 1) + "%" : n(0)}</td><td>${x.impressions ? fmt(x.position, 1) : `<span class="na">·</span>`}</td></tr>`;
    })
    .join("");
  const ctr = (r) => (r.impressions ? `${fmt((100 * r.clicks) / r.impressions, 1)}%` : "");
  const top = (rows, label) => rows.slice(0, 25).map((r) => `<tr><th>${label(r.keys[0])}</th><td>${n(r.clicks)}</td><td>${n(r.impressions)}</td><td>${ctr(r)}</td><td>${fmt(r.position, 1)}</td></tr>`).join("");
  const path = (u) => { try { const x = new URL(u); return decodeURIComponent(x.pathname + x.search); } catch { return u; } };
  const page = (u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(path(u).length > 70 ? path(u).slice(0, 70) + "…" : path(u))}</a>`;
  const cols = `<th>Кліки</th><th>Покази</th><th>CTR</th><th>Позиція</th>`;
  return `${head}
<p class="muted small">З Google Search Console, ${short(g.from)} – ${short(g.to)} (Google віддає дані з затримкою в 2–3 дні). Оновлюється раз на добу, востаннє ${short(dayOf(g.at))}.${g.error ? ` Остання спроба не вдалась: ${esc(g.error)}` : ""}</p>
${tiles}
<h3>По тижнях</h3>
<div class="tbl"><table>
<thead><tr><th>Тиждень</th>${cols}</tr></thead>
<tbody>${weekRows}</tbody></table></div>
${g.queries.length ? `<h3>Запити за 28 днів</h3>
<div class="tbl"><table class="refs">
<thead><tr><th>Запит</th>${cols}</tr></thead>
<tbody>${top(g.queries, esc)}</tbody></table></div>` : ""}
${g.pages.length ? `<h3>Сторінки за 28 днів</h3>
<div class="tbl"><table class="urls">
<thead><tr><th>Сторінка</th>${cols}</tr></thead>
<tbody>${top(g.pages, page)}</tbody></table></div>` : ""}`;
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
<section class="page-head"><div><p class="crumbs"><a href="/admin">Статистика</a> / Читачі</p><h1>Читачі</h1><p class="sub">«Днів» — скільки різних днів читач був на сайті після реєстрації. Заголовки сортують таблицю.</p></div></section>
<form class="find admin-find" action="/admin/readers" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="ім'я або нікнейм" autocomplete="off" aria-label="Пошук читача">${min ? `<input type="hidden" name="books" value="${min}">` : ""}${sort !== "created" ? `<input type="hidden" name="sort" value="${sort}">` : ""}</form>
<p class="filter">${filters}${q ? ` · знайдено ${all.length} <a href="${url({ query: "" })}">скинути пошук</a>` : ""}</p>
${pager}
${shown.length ? `<div class="tbl"><table class="readers">
<thead><tr><th>Читач</th>${col("created", "Зареєструвався")}${col("last", "Востаннє")}${col("days", "Днів")}${col("books", "Книжок")}<th>Звідки</th><th>Лист</th></tr></thead>
<tbody>${shown.map(readerRow).join("")}</tbody></table></div>` : `<p class="muted">Нікого не знайдено.</p>`}
${pager}
</section>`;
  return layout({ title: "Читачі · Статистика", user, path: "/admin", body });
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
  const growth = (back) => (at(back) === null || !days.length ? "" : `+${c.works - at(back)}`);
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
  const tiles = `<div class="stats">${tile(c.works, "книжок у каталогі", `${c.items} видань на ${c.shelves.filter((s) => !s.draft).length} полицях`)}${tile(growth(7) || "·", "за 7 днів", growth(1) ? `${growth(1)} за добу` : "ще нема з чим порівняти")}${tile(growth(28) || "·", "за 28 днів")}${tile(c.draft, "у чернетках", c.draft ? `${c.shelves.filter((s) => s.draft).length} полиць бачиш лише ти` : "")}</div>`;
  // On /admin only the summary, the tables on /admin/shelves (Max, 2026-10-25: like «Нові читачі»).
  if (!full) return `<h2>Каталог</h2>\n${tiles}\n<p class="small"><a class="text-link" href="/admin/shelves">Каталог по днях і по полицях (${c.shelves.length})</a></p>`;
  return `<section class="admin">
<section class="page-head"><div><p class="crumbs"><a href="/admin">Статистика</a> / Каталог</p><h1>Каталог</h1><p class="sub">Книжка — один твір з усіма виданнями (папір, e-book, аудіо, різні видавництва). Чернетки бачиш лише ти; книжки, які є й на відкритих полицях, у чернетках не рахуються. Рахується з 25 жовтня.</p></div></section>
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
  return layout({ title: "Каталог · Статистика", user, path: "/admin", body: catalogBlock(catalog, true) });
}

function adminPage({ user, stats: s, overviews: o = null, catalog = null, gsc = null, gscOn = false, layout, page = "main" }) {
  const traffic = page === "traffic";
  const t = s.totals;
  const tiles = [
    tile(t.readers, "читачів", `+${t.signupsWeek} за тиждень, +${t.signupsMonth} за місяць`),
    tile(t.activeWeek, "активних за 7 днів", `${t.returningWeek} повернулись, ${t.activeToday} сьогодні`),
    tile(t.activeMonth, "активних за 28 днів", t.readers ? `${Math.round((100 * t.activeMonth) / t.readers)}% усіх читачів` : ""),
    tile(t.entries, "книжок на полицях", `+${t.entriesWeek} за тиждень · ${t.want} у «хочу прочитати»`),
    tile(t.ratings, "оцінок", `${t.notes} нотаток`),
    tile(t.follows, "стежень", `${t.digestOn} підписані на лист, ${t.digestOff} відписались`),
    tile("→", `<a href="/admin/catalog">якість каталогу</a>`, "жанри, мова, оригінали, переклади"),
    tile("→", `<a href="/admin/free">вільні книжки</a>`, "з «Хочу прочитати», вже без авторського права"),
    ...(o ? [tile(o.n, `<a href="/admin/overviews">оглядів від Claude</a>`, `${o.today} сьогодні · ${o.queue} в черзі · 🤩 ${o.up} 🙂 ${o.mid} 🙁 ${o.down} · ≈ $${o.cost.toFixed(2)}`)] : []),
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

  // Readers live on /admin/readers; here only a link and this week's count (Max, 2026-10-23: no table here).
  const fresh = s.readers.filter((r) => !r.owner && r.created >= addDays(s.now, -6));

  const d = s.digest;
  const digestLine = d ? `Останню розсилку виконано ${short(dayOf(d.finished || d.started))}: надіслано ${d.sent}, пропущено ${d.skipped}${d.errors?.length ? `, помилок ${d.errors.length}` : ""}.` : "Розсилка ще не виконувалась.";

  // /admin is about readers and retention, /admin/traffic about where visitors come from (Max, 2026-10-24).
  const body = traffic
    ? `<section class="admin">
<section class="page-head"><div><p class="crumbs"><a href="/admin">Статистика</a> / Трафік</p><h1>Трафік</h1></div></section>

${gscBlock(gsc, gscOn)}

${arrivalsDetails(s.arrivals)}

<h2>Перегляди за розділами</h2>
<p class="muted small">Скільки сторінок кожного розділу відкрили (читачі й гості разом, без ботів). Рахується з ${s.sections.length ? "22 жовтня" : "сьогодні"}; які саме сторінки, не зберігаємо.</p>
${s.sections.length ? `<div class="tbl"><table class="sections">
<thead><tr><th>Розділ</th><th>Сьогодні</th><th>7 днів</th><th>28 днів</th></tr></thead>
<tbody>${s.sections.map((x) => `<tr><th>${x.name}</th><td>${n(x.today)}</td><td>${n(x.week)}</td><td>${n(x.month)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Поки нічого не нарахувалось.</p>`}

</section>`
    : `<section class="admin">
<section class="page-head"><div><h1>Статистика</h1><p class="sub">Сайт станом на ${short(s.now)}. Активний читач — той, хто відкрив сайт або щось зробив на полиці того дня. Перегляди рахуються з ${s.totals.viewsSince ? short(s.totals.viewsSince) : "сьогодні"}; раніше за активність правлять входи й зміни на полиці.</p></div></section>
<div class="stats">${tiles}</div>
<h2>Нові читачі</h2>
<div class="tbl"><table class="readers">
<thead><tr>${READER_HEAD}</tr></thead>
<tbody>${s.readers.filter((r) => !r.owner).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5).map(readerRow).join("")}</tbody></table></div>
<p class="small"><a class="text-link" href="/admin/readers">Усі читачі (${s.readers.length})</a>, нових за 7 днів: ${fresh.length}.</p>

${s.arrivals ? `<h2>Звідки приходять</h2>
${sourcesTable(s.arrivals, 4)}
<p class="small"><a class="text-link" href="/admin/speed">Швидкість сайту</a></p>
<p class="small"><a class="text-link" href="/admin/traffic">Усі джерела (${s.arrivals.sources.length})</a>, звідки саме, сторінки з пошуку, перегляди за розділами.</p>` : ""}

${funnelBlock(s.funnel)}

${catalogBlock(catalog)}

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

<h2>Щотижневий лист</h2>
<p>${digestLine} <a class="text-link" href="/admin/digest">Твій текст у листі</a> · <a class="text-link" href="/digest/preview">Переглянути свій лист</a> · <a class="text-link" href="/digest/status">стан розсилки</a> · <a class="text-link" href="/refresh-status">стан каталогів</a> · <a class="text-link" href="/admin/refresh">оновити каталоги зараз</a></p>
<p class="muted small">Сесій (пристроїв, що залишились увійшовши): ${t.sessions}.</p>
</section>`;
  return layout({ title: traffic ? "Трафік · Статистика" : "Статистика", user, path: "/admin", body });
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
<p class="small"><a href="/admin">← Статистика</a></p>
<h1>Огляди від Claude</h1>
<p>${n(o.n)} оглядів, ${o.auto} зроблені самі · 🤩 ${o.up} · 🙂 ${o.mid} · 🙁 ${o.down} · ${o.queue} в черзі · ≈ $${o.cost.toFixed(2)} за весь час</p>
<p class="muted">Поточна версія промпту ${o.version}: ${o.current} з ${o.n} · невдалих після рестарту: ${o.failed}${o.lastError ? ` · остання помилка: ${esc(o.lastError)}` : ""}</p>
<table><thead><tr><th>Книжка</th><th>🤩</th><th>🙂</th><th>🙁</th><th>Коли</th><th>Хто</th><th>Пошуків</th><th>Токенів in</th><th>out</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
  return layout({ title: "Огляди від Claude · Статистика", user, path: "/admin", body });
}

// /admin/speed (speed.js): how fast the site was, before we counted (Fly's metrics, the logs) and day by day since.
function speedPage({ user, days, layout }) {
  const { HISTORY, EDGES } = require("./speed");
  const s = (ms) => (ms == null ? "" : ms === Infinity ? `> ${EDGES[EDGES.length - 1] / 1000} с` : `${String(ms / 1000).replace(".", ",")} с`);
  const pct = (x) => (x == null ? "" : `${String(Math.round(x * 1000) / 10).replace(".", ",")}%`);
  const short = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const cell = (k) => (k ? `<td>${s(k.median)}</td><td>${s(k.p95)}</td><td>${pct(k.slow)}</td><td class="muted">${n(k.n)}</td>` : `<td></td><td></td><td></td><td></td>`);
  const { before: b, after: a } = HISTORY.logs;
  const maxP95 = Math.max(...HISTORY.fly.map((r) => r[2]));
  const bars = HISTORY.fly.map(([d, , p95]) => `<div title="${short(d)}: 95% відповідей за ${String(p95).replace(".", ",")} с"><span style="height:${Math.max(2, Math.round((p95 / maxP95) * 100))}%"></span><b>${String(p95).replace(".", ",")}</b><i>${short(d)}</i></div>`).join("");
  const rows = [...days].map(([d, k]) => `<tr><th>${short(d)}</th>${cell(k.page)}${cell(k.phone)}<td>${k.stall ? `${Math.round(k.stall.sum / 1000)} с` : "0"}</td><td class="muted">${k.bot ? n(k.bot.n) : ""}</td></tr>`).join("");
  const body = `<section class="admin speed">
<p class="small"><a href="/admin">← Статистика</a></p>
<section class="page-head"><div><h1>Швидкість сайту</h1><p class="sub">Що казали метрики Fly й наші журнали до 26 жовтня, і що ми рахуємо самі відтоді: скільки сервер думав над сторінкою і за скільки вона відкрилась у браузері читача. Тільки числа за день, без адрес і людей.</p></div></section>

<h2>Було → стало</h2>
<div class="stats">
  <div class="stat"><b>${b.slowPages} → ${a.slowPages}</b>сторінок на день, які вантажились понад 2 с</div>
  <div class="stat"><b>${b.over5s} → ${a.over5s}</b>з них понад 5 с</div>
  <div class="stat"><b>${b.worst} → ${String(a.worst).replace(".", ",")} с</b>найдовше очікування</div>
  <div class="stat"><b>${String(b.stillMin).replace(".", ",")} → ${String(a.stillMin).replace(".", ",")} хв</b>на день сайт стояв і нікому не відповідав</div>
</div>
<p class="muted small">Із журналів сервера: ${b.from} – ${b.to} (до виправлень) і ${a.from} – ${a.to} (після), час київський, у перерахунку на добу.</p>

<h3>95% відповідей сервера встигали за…</h3>
<div class="speed-bars">${bars}</div>
<p class="muted small">Метрики Fly, усі відповіді сайту разом з обкладинками й запитами до ШІ, тож це повільніше, ніж самі сторінки. 26.10 до 08:50.</p>

<h2>День за днем</h2>
${days.size ? `<div class="tbl"><table>
<thead><tr><th rowspan="2">День</th><th colspan="4">Сервер: сторінки для людей</th><th colspan="4">Браузер на телефоні: сторінка відкрилась</th><th rowspan="2">Сервер стояв</th><th rowspan="2">Роботам</th></tr>
<tr><th>Медіана</th><th>95%</th><th>&gt; 2 с</th><th>Скільки</th><th>Медіана</th><th>95%</th><th>&gt; 2 с</th><th>Скільки</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="muted small">Медіана й 95% — верхня межа кошика (до 0,1 / 0,2 / 0,5 / 1 / 2 / 5 / 10 с): «95% за 0,2 с» значить, що 95 сторінок зі 100 сервер віддав швидше за 0,2 с.</p>` : `<p class="muted">Рахуємо з сьогодні; перші числа з'являться за хвилину після першої сторінки.</p>`}
</section>`;
  return layout({ title: "Швидкість · Статистика", user, path: "/admin", body });
}

module.exports = { BOT, Admin, adminPage, shelvesPage, readersPage, overviewsPage, speedPage, dayOf, weekOf, sectionOf };
