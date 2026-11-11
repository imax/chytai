// The morning report in the owner's Telegram (Max, 2026-11-08: «хочу дейлі репорт в телеграм зранку, зі
// статистикою за вчора»). Once a day after REPORT_HOUR Kyiv time, from the jobs process: yesterday's sign-ups and
// where they came from, who came back, what readers added, the reader app's minutes and explanations, errors.
// The owner and test addresses (auth.testAddress) are not counted. A few small queries over one day: no full scans
// of entries or visits.
const { dayOf } = require("./admin");
const { testAddress } = require("./auth");
const telegram = require("./telegram");
const errorsLib = require("./errors");

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
    // A reader who imported that day: their books count under the import only (an import may date them that day).
    books: all("SELECT reader FROM entries WHERE added = ?", day).filter((r) => real(r) && !imports.some((i) => i.reader === r.reader)).length,
    imported: imports.reduce((s, r) => s + r.n, 0),
    ratings: count("SELECT reader, at FROM rated WHERE at BETWEEN ? AND ?"),
    lists: count("SELECT reader, created AS at FROM lists WHERE created BETWEEN ? AND ?"),
    comments: count("SELECT reader, created AS at FROM list_comments WHERE created BETWEEN ? AND ?"),
    club: count("SELECT reader, created AS at FROM club_posts WHERE created BETWEEN ? AND ?") + count("SELECT reader, created AS at FROM club_topics WHERE created BETWEEN ? AND ?"),
    searches: all("SELECT SUM(n) AS n FROM search_log WHERE day = ?", day)[0]?.n || 0,
    errors: dayErrors(all, lo, hi, inDay),
    failed: [...new Set(jobs.filter((r) => inDay(r.started)).map((r) => r.job))],
  };
}

// The day's errors (errors.js), grouped by kind; new = a kind the 30 days kept had not seen before that day. They no
// longer go to Telegram one by one (Max, 2026-11-11): here they are counted, and the new ones named.
function dayErrors(all, lo, hi, inDay) {
  const rows = all("SELECT at, place, msg FROM errors WHERE at BETWEEN ? AND ?", lo, hi).filter((r) => inDay(r.at));
  if (!rows.length) return { n: 0, groups: [] };
  const first = rows.reduce((m, r) => (r.at < m ? r.at : m), rows[0].at);
  const seen = new Set(all("SELECT DISTINCT place, msg FROM errors WHERE at < ?", first).map((r) => errorsLib.kind(r.place, r.msg)));
  const groups = new Map();
  for (const r of rows) {
    const k = errorsLib.kind(r.place, r.msg);
    const g = groups.get(k) || groups.set(k, { place: r.place, msg: r.msg, n: 0, fresh: !seen.has(k) }).get(k);
    g.n++;
  }
  return { n: rows.length, groups: [...groups.values()].sort((a, b) => b.fresh - a.fresh || b.n - a.n) };
}

// The reader app's day (server/index.js GET /api/site-admin/day): per account, so the site leaves out its own skip list.
function readerDay(r, skip, titleOf = () => "") {
  if (!r) return null;
  const keep = (m = {}) => Object.entries(m).filter(([id]) => !skip.has(id));
  const sum = (m) => keep(m).reduce((s, [, n]) => s + n, 0);
  const byTitle = {};
  for (const b of r.books || []) {
    if (skip.has(b.acct)) continue;
    const title = titleOf(b.acct, b.name) || b.title || b.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    byTitle[title] = (byTitle[title] || 0) + b.sec;
  }
  const books = Object.entries(byTitle).map(([title, sec]) => ({ title, sec })).filter((b) => b.sec >= 60).sort((a, b) => b.sec - a.sec);
  return {
    readers: keep(r.readSec).filter(([, s]) => s >= 60).length,
    minutes: Math.round(sum(r.readSec) / 60),
    explains: sum(r.explains),
    notes: sum(r.notes),
    cost: r.cost || 0,
    top: books[0] || null,
    // Pages the phones unloaded (server/index.js /api/page-gone), test accounts left out; guests count.
    gone: (r.gone || []).filter((g) => !skip.has(g.acct)).length,
    goneFront: (r.gone || []).filter((g) => !skip.has(g.acct) && !g.bg).length,
  };
}

const n = (x) => x.toLocaleString("uk-UA");
function text(day, s, rd, site, backup = "", triage = "") {
  const lines = [`Chytai за ${dayName(day)}`, ""];
  const from = s.from.map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`Нові читачі: ${s.signups}${from ? ` (${from})` : ""}`);
  lines.push(`Заходили: ${s.came}, з них повернулися ${s.back}`);
  lines.push(`Візитів на сайт: ${n(s.visits)}, з них уперше ${n(s.newPeople)}`);
  lines.push(`На полиці: +${n(s.books)}${s.imported ? `, з імпорту ще ${n(s.imported)}` : ""}${s.ratings ? `, оцінок ${s.ratings}` : ""}`);
  const ugc = [s.lists && `списків ${s.lists}`, s.comments && `коментарів ${s.comments}`, s.club && `у клубі ${s.club}`, s.searches && `пошуків ${s.searches}`].filter(Boolean);
  if (ugc.length) lines.push(ugc.join(", ").replace(/^./, (c) => c.toUpperCase()));
  lines.push("");
  if (rd) {
    lines.push(`Читалка: читали ${rd.readers}, ${n(rd.minutes)} хв`);
    if (rd.top) lines.push(`Найбільше: «${rd.top.title}», ${Math.round(rd.top.sec / 60)} хв`);
    lines.push(`Пояснень ${rd.explains}, нотаток ${rd.notes}, Claude $${rd.cost.toFixed(2)}`);
    if (rd.gone) lines.push(`Сторінку вивантажено: ${rd.gone}${rd.goneFront ? `, з них на екрані ${rd.goneFront}` : ", усі у фоні"}`);
  } else lines.push("Читалка не відповіла.");
  lines.push("");
  const e = s.errors, fresh = e.groups.filter((g) => g.fresh);
  if (!e.n && !s.failed.length) lines.push("Збоїв не було.");
  else {
    lines.push(`Збої: помилок ${e.n}${e.n ? ` (видів ${e.groups.length}, нових ${fresh.length})` : ""}${s.failed.length ? `, задачі впали: ${s.failed.join(", ")}` : ""}`);
    // The new kinds, a few: what to look at. Known ones are only counted.
    for (const g of fresh.slice(0, 3)) lines.push(`• ${errorsLib.PLACES[g.place] || g.place}: ${g.msg.length > 100 ? `${g.msg.slice(0, 99)}…` : g.msg}${g.n > 1 ? ` ×${g.n}` : ""}`);
    if (fresh.length > 3) lines.push(`• і ще нових ${fresh.length - 3}`);
    if (e.n) lines.push(`${site}/admin/speed#errors`);
  }
  if (triage) lines.push(`Розбір помилок: ${triage}`);
  if (backup) lines.push(backup);
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
  const titleOf = (acct, name) => {
    try {
      return db.prepare("SELECT title FROM reader_files WHERE reader = ? AND name = ?").get(acct, name)?.title || "";
    } catch {
      return "";
    }
  };
  let backup = "";
  try {
    backup = require("./backups").line(db);
  } catch {}
  // The morning error review (POST /agent/triage) runs at 07:00: its note of the last 12 hours, or a word that it
  // did not come although there were errors.
  let triage = "";
  try {
    const t = JSON.parse(db.get("triage:last") || "null");
    if (t && Date.now() - Date.parse(t.at) < 12 * 3600000) triage = t.text;
    else if (s.errors.n) triage = "сьогодні не запускався.";
  } catch {}
  return text(day, s, readerDay(r, s.skip, titleOf), site, backup, triage);
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
