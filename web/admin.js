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

class Admin {
  constructor(db, { ownerId = "owner" } = {}) {
    this.db = db;
    this.ownerId = ownerId;
    this.seen = new Set(); // `${day}:${reader}` already written today
    this.seenDay = "";
  }

  // A page opened: remember the reader's day and count the view. Cheap: one insert per reader a day,
  // one upsert per view (SQLite in WAL mode takes that without noticing at this size).
  touch(req, readerId) {
    if (req.method !== "GET") return;
    const accept = req.headers.accept || "";
    if (accept && !accept.includes("text/html")) return;
    const p = req.path || "";
    if (p.startsWith("/api/") || p === "/refresh-status" || p === "/admin" || p.includes(".")) return;
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
    } catch (e) {
      console.error("admin touch failed:", e.message);
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
          last: days[days.length - 1] || null,
          days: days.length,
          books: books.get(r.id) || 0,
          ratings: ratings.get(r.id) || 0,
          notes: notes.get(r.id) || 0,
          following: following.get(r.id) || 0,
          followers: followers.get(r.id) || 0,
          digest: r.digest !== 0 && !!r.email,
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
      cohorts,
      later: LATER,
      readers: readerRows,
      digest: digestLast ? { ...digestLast, lastRun: db.get("digest:lastRun") } : null,
    };
  }
}

// ---- the page ----

const n = (v) => (v ? String(v) : `<span class="zero">0</span>`);
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const short = (day) => (day ? `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : "—");
const weekLabel = (w) => `${short(w)} – ${short(addDays(w, 6))}`;
const tile = (value, label, sub = "") => `<div class="stat"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
const pct = (c) => (c === null ? `<td class="na">·</td>` : `<td class="pct${c.partial ? " partial" : ""}${c.pct >= 50 ? " hi" : c.pct > 0 ? " mid" : ""}" title="${c.back} з когорти${c.partial ? ", тиждень ще триває" : ""}">${c.pct}%</td>`);

// `withBooks`: the readers table shows only readers with a book on the shelf (Max, 2026-10-20: «фільтр 1+ книжка»);
// `sort`: last (activity, the default), books or created (Max, 2026-10-21: fewer columns, sortable).
function adminPage({ user, stats: s, layout, withBooks = false, sort = "created" }) {
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

  const SORTS = { last: (a, b) => (b.last || "").localeCompare(a.last || "") || a.created.localeCompare(b.created), books: (a, b) => b.books - a.books || a.created.localeCompare(b.created), created: (a, b) => b.created.localeCompare(a.created) };
  if (!SORTS[sort]) sort = "created"; // newest readers on top by default (Max, 2026-10-21: «неясно як знайти нових»)
  const shown = (withBooks ? s.readers.filter((r) => r.books) : s.readers).slice().sort(SORTS[sort]);
  const url = ({ books = withBooks, by = sort } = {}) => `/admin${[books ? "books=1" : "", by !== "created" ? `sort=${by}` : ""].filter(Boolean).map((q, i) => (i ? "&" : "?") + q).join("")}`;
  const col = (key, label) => (sort === key ? `<th class="sorted">${label} ↓</th>` : `<th><a href="${url({ by: key })}" title="Відсортувати">${label}</a></th>`);
  const readerRows = shown
    .map(
      (r) => `<tr${r.owner ? ' class="owner"' : ""}>
  <th><a href="/@${esc(r.username)}">${esc(r.name)}</a> <span class="muted">@${esc(r.username)}</span>${!r.owner && r.created >= addDays(s.now, -6) ? ` <em class="new">новий</em>` : ""}</th>
  <td>${short(r.created)}</td><td>${short(r.last)}</td><td>${n(r.days)}</td><td>${n(r.books)}</td>
  <td>${r.digest ? "так" : r.email ? "ні" : `<span class="muted">без пошти</span>`}</td>
</tr>`
    )
    .join("");

  const d = s.digest;
  const digestLine = d ? `Останню розсилку виконано ${short(dayOf(d.finished || d.started))}: надіслано ${d.sent}, пропущено ${d.skipped}${d.errors?.length ? `, помилок ${d.errors.length}` : ""}.` : "Розсилка ще не виконувалась.";

  const body = `<section class="admin">
<section class="page-head"><div><p class="kicker">Лише для власника</p><h1>Статистика</h1><p class="sub">Сайт станом на ${short(s.now)}. Активний читач — той, хто відкрив сайт або щось зробив на полиці того дня. Перегляди рахуються з ${s.totals.viewsSince ? short(s.totals.viewsSince) : "сьогодні"}; раніше за активність правлять входи й зміни на полиці.</p></div></section>
<div class="stats">${tiles}</div>

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

<h2>Читачі</h2>
<p class="muted small">Нові зверху; «новий» — зареєструвався за останні 7 днів. «Днів» — скільки різних днів читач був на сайті після реєстрації. Заголовки «Зареєструвався», «Востаннє» і «Книжок» сортують таблицю.</p>
<p class="filter">${withBooks ? `<a href="${url({ books: false })}">Усі (${s.readers.length})</a> · <b>1+ книжка (${shown.length})</b>` : `<b>Усі (${s.readers.length})</b> · <a href="${url({ books: true })}">1+ книжка (${s.readers.filter((r) => r.books).length})</a>`}</p>
<div class="tbl"><table class="readers">
<thead><tr><th>Читач</th>${col("created", "Зареєструвався")}${col("last", "Востаннє")}<th>Днів</th>${col("books", "Книжок")}<th>Лист</th></tr></thead>
<tbody>${readerRows}</tbody></table></div>

<h2>Щотижневий лист</h2>
<p>${digestLine} <a class="text-link" href="/digest/preview">Переглянути свій лист</a> · <a class="text-link" href="/digest/status">стан розсилки</a> · <a class="text-link" href="/refresh-status">стан каталогів</a></p>
<p class="muted small">Сесій (пристроїв, що залишились увійшовши): ${t.sessions}.</p>
</section>`;
  return layout({ title: "Статистика", user, path: "/admin", body });
}

module.exports = { Admin, adminPage, dayOf, weekOf };
