// The morning report in the owner's Telegram (Max, 2026-11-08: «хочу дейлі репорт в телеграм зранку, зі
// статистикою за вчора»). Once a day after REPORT_HOUR Kyiv time, from the jobs process: yesterday's sign-ups and
// where they came from, who came back, what readers added, the reader app's minutes and explanations, errors.
// The owner and test addresses (auth.testAddress) are not counted. A few small queries over one day: no full scans
// of entries or visits.
const { dayOf } = require("./admin");
const { testAddress } = require("./auth");
const telegram = require("./telegram");

const REPORT_HOUR = 8; // Kyiv; before the Friday letter (9:30) and wantmail (10:00)
const DAY = 86400000;
const toDate = (day) => new Date(`${day}T12:00:00`);
const addDays = (day, n) => dayOf(toDate(day).getTime() + n * DAY);
const WEEKDAY = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const dayName = (day) => `${WEEKDAY[toDate(day).getDay()]}, ${toDate(day).toLocaleDateString("uk-UA", { day: "numeric", month: "long" })}`;

// The site's numbers for one Kyiv day.
function siteDay(db, day, ownerId) {
  // Times are kept in UTC: a window wide enough for any Kyiv day, then dayOf() picks the day's own.
  const lo = new Date(toDate(day).getTime() - DAY).toISOString(), hi = new Date(toDate(day).getTime() + DAY).toISOString();
  const inDay = (iso) => !!iso && dayOf(iso) === day;
  const all = (sql, ...a) => {
    try {
      return db.prepare(sql).all(...a);
    } catch {
      return []; // a table a module makes on its own start may not be there yet
    }
  };
  const readers = all("SELECT id, email, created, came FROM readers");
  const skip = new Set([ownerId, ...readers.filter((r) => testAddress(r.email)).map((r) => r.id)]);
  const real = (r) => !skip.has(r.reader);
  const count = (sql) => all(sql, lo, hi).filter((r) => real(r) && inDay(r.at)).length;

  const fresh = readers.filter((r) => !skip.has(r.id) && inDay(r.created));
  const from = {};
  for (const r of fresh) {
    let src = "Напряму";
    try {
      src = JSON.parse(r.came || "null")?.source || src;
    } catch {}
    from[src] = (from[src] || 0) + 1;
  }
  const createdDay = Object.fromEntries(readers.map((r) => [r.id, dayOf(r.created)]));
  // Who was around: a page of the site that day, or signed up (from the reader app a new reader may open none).
  const came = new Set([...all("SELECT reader FROM visits WHERE day = ?", day).filter(real).map((r) => r.reader), ...fresh.map((r) => r.id)]);
  const arrivals = all("SELECT SUM(visits) AS visits, SUM(fresh) AS fresh FROM arrivals WHERE day = ?", day)[0] || {};
  const imports = all("SELECT reader, at, n FROM shelf_imports WHERE at BETWEEN ? AND ?", lo, hi).filter((r) => real(r) && inDay(r.at));
  const jobs = all("SELECT job FROM job_runs WHERE ok = 0 AND started BETWEEN ? AND ?", lo, hi);
  return {
    skip,
    signups: fresh.length,
    from: Object.entries(from).sort((a, b) => b[1] - a[1]),
    came: came.size,
    back: [...came].filter((id) => createdDay[id] && createdDay[id] < day).length,
    visits: arrivals.visits || 0,
    newPeople: arrivals.fresh || 0,
    // entries.added is a Kyiv day; an import keeps the dates from Goodreads, so imports are counted apart.
    books: all("SELECT reader FROM entries WHERE added = ?", day).filter(real).length,
    imported: imports.reduce((s, r) => s + r.n, 0),
    ratings: count("SELECT reader, at FROM rated WHERE at BETWEEN ? AND ?"),
    lists: count("SELECT reader, created AS at FROM lists WHERE created BETWEEN ? AND ?"),
    comments: count("SELECT reader, created AS at FROM list_comments WHERE created BETWEEN ? AND ?"),
    club: count("SELECT reader, created AS at FROM club_posts WHERE created BETWEEN ? AND ?") + count("SELECT reader, created AS at FROM club_topics WHERE created BETWEEN ? AND ?"),
    searches: all("SELECT SUM(n) AS n FROM search_log WHERE day = ?", day)[0]?.n || 0,
    errors: all("SELECT at FROM errors WHERE at BETWEEN ? AND ?", lo, hi).filter((r) => inDay(r.at)).length,
    failed: [...new Set(jobs.filter((r) => inDay(r.started)).map((r) => r.job))],
  };
}

// The reader app's day (server/index.js GET /api/site-admin/day): per account, so the site leaves out its own skip list.
function readerDay(r, skip) {
  if (!r) return null;
  const keep = (m = {}) => Object.entries(m).filter(([id]) => !skip.has(id));
  const sum = (m) => keep(m).reduce((s, [, n]) => s + n, 0);
  const books = (r.books || [])
    .map((b) => ({ title: b.title, sec: sum(b.sec) }))
    .filter((b) => b.title && b.sec >= 60)
    .sort((a, b) => b.sec - a.sec);
  return {
    readers: keep(r.readSec).filter(([, s]) => s >= 60).length,
    minutes: Math.round(sum(r.readSec) / 60),
    explains: sum(r.explains),
    notes: sum(r.notes),
    cost: r.cost || 0,
    top: books[0] || null,
  };
}

const n = (x) => x.toLocaleString("uk-UA");
function text(day, s, rd, site) {
  const lines = [`Chytai за ${dayName(day)}`, ""];
  const from = s.from.map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`Нові читачі: ${s.signups}${from ? ` (${from})` : ""}`);
  lines.push(`Заходили: ${s.came}, з них повернулися ${s.back}`);
  lines.push(`Відвідин: ${n(s.visits)}, нових людей ${n(s.newPeople)}`);
  lines.push(`На полиці: +${n(s.books)}${s.imported ? ` (імпорт ${n(s.imported)})` : ""}${s.ratings ? `, оцінок ${s.ratings}` : ""}`);
  const ugc = [s.lists && `списків ${s.lists}`, s.comments && `коментарів ${s.comments}`, s.club && `у клубі ${s.club}`, s.searches && `пошуків ${s.searches}`].filter(Boolean);
  if (ugc.length) lines.push(ugc.join(", ").replace(/^./, (c) => c.toUpperCase()));
  lines.push("");
  if (rd) {
    lines.push(`Читалка: читали ${rd.readers}, ${n(rd.minutes)} хв`);
    if (rd.top) lines.push(`Найбільше: «${rd.top.title}», ${Math.round(rd.top.sec / 60)} хв`);
    lines.push(`Пояснень ${rd.explains}, нотаток ${rd.notes}, Claude $${rd.cost.toFixed(2)}`);
  } else lines.push("Читалка не відповіла.");
  lines.push("");
  lines.push(s.errors || s.failed.length ? `Збої: помилок ${s.errors}${s.failed.length ? `, задачі впали: ${s.failed.join(", ")}` : ""}` : "Збоїв не було.");
  lines.push("", `${site}/admin`);
  return lines.join("\n");
}

async function build({ db, day, ownerId, site, reader }) {
  const s = siteDay(db, day, ownerId);
  let r = null;
  try {
    r = await reader(day);
  } catch (e) {
    console.error(`daily report: reader ${e.message}`);
  }
  return text(day, s, readerDay(r, s.skip), site);
}

// In the jobs process: a look every 10 minutes; the day is sent once (meta `dailyreport:lastRun`).
function schedule(opts) {
  const { db } = opts;
  const tick = async () => {
    const now = new Date();
    const today = dayOf(now);
    if (now.getHours() < REPORT_HOUR || db.get("dailyreport:lastRun") === today || !telegram.on() || !telegram.chat()) return;
    db.set("dailyreport:lastRun", today);
    try {
      await telegram.send(await build({ ...opts, day: addDays(today, -1) }));
    } catch (e) {
      console.error(`daily report: ${e.message}`);
    }
  };
  setInterval(tick, 10 * 60000).unref();
  setTimeout(tick, 3 * 60000).unref();
}

module.exports = { build, schedule, siteDay, readerDay, text };
