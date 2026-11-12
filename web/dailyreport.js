// Two reports in the owner's Telegram, from the jobs process.
// - Readers (Max, 2026-11-08: «хочу дейлі репорт в телеграм зранку, зі статистикою за вчора»): once a day after
//   REPORT_HOUR Kyiv, yesterday's sign-ups and where they came from, who came back, what readers added, the reader
//   app's minutes and explanations. Nothing technical (Max, 2026-11-12: «цей технічний звіт сюди не ліпити»).
// - Technical (Max, 2026-11-12: «об'єднати його з бекапом… після того, як ми переконалися, що бекап пройшов успішно,
//   пофіксили помилки»): once a day when the night's backups of the site and the reader have reported (backups.js)
//   and the morning error review has left today's note (/agent/triage), whenever that is; at DEADLINE_HOUR (10:00) at
//   the latest, saying what has not come. Backups, yesterday's errors and failed jobs, the review's note, unloads.
// The owner and test addresses (auth.testAddress) are not counted. A few small queries over one day: no full scans
// of entries or visits.
const { dayOf } = require("./admin");
const { testAddress } = require("./auth");
const telegram = require("./telegram");
const errorsLib = require("./errors");
const backups = require("./backups");
const os = require("os");
const storageLib = require("./storage");

const REPORT_HOUR = 8; // Kyiv; before the Friday letter (9:30) and wantmail (10:00)
const DAY = 86400000;
const toDate = (day) => new Date(`${day}T12:00:00`);
const addDays = (day, n) => dayOf(toDate(day).getTime() + n * DAY);
const WEEKDAY = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const dayName = (day) => `${WEEKDAY[toDate(day).getDay()]}, ${toDate(day).toLocaleDateString("uk-UA", { day: "numeric", month: "long" })}`;

// Times are kept in UTC: a window wide enough for any Kyiv day, then dayOf() picks the day's own.
function span(db, day) {
  return {
    lo: new Date(toDate(day).getTime() - DAY).toISOString(),
    hi: new Date(toDate(day).getTime() + DAY).toISOString(),
    inDay: (iso) => !!iso && dayOf(iso) === day,
    all: (sql, ...a) => {
      try {
        return db.prepare(sql).all(...a);
      } catch {
        return []; // a table a module makes on its own start may not be there yet
      }
    },
  };
}

// The owner and test accounts: left out of every count.
function skipped(db, ownerId) {
  const readers = span(db, "2000-01-01").all("SELECT id, email, created, came FROM readers");
  return { readers, skip: new Set([ownerId, ...readers.filter((r) => testAddress(r.email)).map((r) => r.id)]) };
}

// The site's numbers for one Kyiv day.
function siteDay(db, day, ownerId) {
  const { lo, hi, inDay, all } = span(db, day);
  const { readers, skip } = skipped(db, ownerId);
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
  };
}

// The technical side of one Kyiv day: errors (errors.js) and the jobs that failed.
function techDay(db, day) {
  const { lo, hi, inDay, all } = span(db, day);
  const jobs = all("SELECT job, started FROM job_runs WHERE ok = 0 AND started BETWEEN ? AND ?", lo, hi);
  return { errors: dayErrors(all, lo, hi, inDay), failed: [...new Set(jobs.filter((r) => inDay(r.started)).map((r) => r.job))] };
}

// The day's errors, grouped by kind; new = a kind the 30 days kept had not seen before that day. They do not go to
// Telegram one by one (Max, 2026-11-11): the technical report counts them and names the new ones.
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
    storage: r.storage || null, // the reader machine's disk and memory (storage.js)
  };
}

const n = (x) => x.toLocaleString("uk-UA");
function text(day, s, rd, site) {
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
  } else lines.push("Читалка не відповіла.");
  lines.push("", `${site}/admin`);
  return lines.join("\n");
}

// Disk and memory of both machines, now (Max, 2026-11-12: from /admin «Performance» into this report). The site's
// memory is its whole machine (the web and jobs processes), the reader's its one process. Near a limit storage.js
// has already told Telegram; here it is named first.
function storageLine(siteSt, readerSt) {
  const pct = (s) => (s?.diskTotal ? `${Math.round((1 - s.diskFree / s.diskTotal) * 100)}%` : "?");
  const mb = (n) => (n ? `${Math.round(n / 1048576)} МБ` : "?");
  const bad = [...storageLib.problems(siteSt, "сайт"), ...storageLib.problems(readerSt, "Читалка")];
  return `${bad.length ? `Закінчується місце чи пам'ять: ${bad.join("; ")}. ` : ""}Диск: сайт ${pct(siteSt)}, Читалка ${pct(readerSt)}. Пам'ять: сайт ${mb(siteSt?.rss)}, Читалка ${mb(readerSt?.rss)}.`;
}

// Search health in one line (Max, 2026-11-12, after Google's clicks fell from ~75 to 1–4 a day on 9.11 and nothing
// told him: «якщо у нас немає трафіку, він зник або навпаки неочікувано багато, щоб про це був якийсь рядок»).
// Our own arrivals from Google for the day (same day, `arrivals`) and Google's own impressions for its latest day
// (Search Console, meta `gsc`, two or three days behind), each next to the median of the 14 days before it.
// Half the norm or less, or twice or more (on a norm of 10 or more), says «різко менше/більше».
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const off = (v, norm) => (norm >= 10 ? (v <= norm / 2 ? -1 : v >= norm * 2 ? 1 : 0) : 0);

function searchDay(db, day) {
  const { all } = span(db, day);
  const from = addDays(day, -14);
  const rows = all("SELECT day, SUM(visits) v FROM arrivals WHERE source = 'Google' AND day BETWEEN ? AND ? GROUP BY day", from, day);
  const by = new Map(rows.map((r) => [r.day, r.v]));
  const before = Array.from({ length: 14 }, (_, i) => by.get(addDays(day, i - 14)) || 0);
  let g = null;
  try {
    g = JSON.parse(db.get("gsc") || "null");
  } catch {}
  const days = (g?.days || []).filter((d) => d.impressions != null);
  const last = days[days.length - 1];
  return {
    visits: by.get(day) || 0,
    visitsNorm: rows.length ? median(before) : null,
    gsc: last ? { day: last.day, impressions: last.impressions, clicks: last.clicks, norm: median(days.slice(-15, -1).map((d) => d.impressions)) } : null,
    error: (db.get("gsc:error") || "").trim(),
  };
}

function searchLine(s) {
  if (!s) return "";
  const norm = (x) => (x != null ? ` (звично ${n(Math.round(x))})` : "");
  const parts = [`переходів ${n(s.visits)}${norm(s.visitsNorm)}`];
  if (s.gsc) parts.push(`показів ${n(s.gsc.impressions)} за ${toDate(s.gsc.day).toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" })}${norm(s.gsc.norm)}`);
  const dir = [off(s.visits, s.visitsNorm), s.gsc ? off(s.gsc.impressions, s.gsc.norm) : 0];
  const head = dir.includes(-1) ? "Пошук Google, різко менше" : dir.includes(1) ? "Пошук Google, різко більше" : "Пошук Google";
  const err = s.error ? ` Search Console не відповідає: ${s.error.slice(0, 80)}` : "";
  return `${head}: ${parts.join(", ")}.${err}`;
}

// The technical report: t = techDay(), rd = readerDay() or null, backup = backups.line(), triage = today's note of the
// morning review or "" (it has not come), storage = storageLine(), search = searchLine().
function techText(day, t, rd, site, backup, triage, storage = "", search = "") {
  const lines = [`Chytai, техніка за ${dayName(day)}`, "", backup];
  const e = t.errors, fresh = e.groups.filter((g) => g.fresh);
  if (!e.n && !t.failed.length) lines.push("Збоїв не було.");
  else {
    lines.push(`Збої: помилок ${e.n}${e.n ? ` (видів ${e.groups.length}, нових ${fresh.length})` : ""}${t.failed.length ? `, задачі впали: ${t.failed.join(", ")}` : ""}`);
    // The new kinds, a few: what to look at. Known ones are only counted.
    for (const g of fresh.slice(0, 3)) lines.push(`• ${errorsLib.PLACES[g.place] || g.place}: ${g.msg.length > 100 ? `${g.msg.slice(0, 99)}…` : g.msg}${g.n > 1 ? ` ×${g.n}` : ""}`);
    if (fresh.length > 3) lines.push(`• і ще нових ${fresh.length - 3}`);
  }
  lines.push(`Розбір помилок: ${triage || "сьогодні не запускався."}`);
  if (rd?.gone) lines.push(`Сторінку вивантажено: ${rd.gone}${rd.goneFront ? `, з них на екрані ${rd.goneFront}` : ", усі у фоні"}`);
  if (!rd) lines.push("Читалка не відповіла.");
  if (storage) lines.push(storage);
  if (search) lines.push(search);
  lines.push("", e.n ? `${site}/admin/speed#errors` : `${site}/admin`);
  return lines.join("\n");
}

async function readerOf(reader, day) {
  try {
    return await reader(day);
  } catch (e) {
    console.error(`daily report: reader ${e.message}`);
    return null;
  }
}

async function build({ db, day, ownerId, site, reader }) {
  const s = siteDay(db, day, ownerId);
  const r = await readerOf(reader, day);
  const titleOf = (acct, name) => {
    try {
      return db.prepare("SELECT title FROM reader_files WHERE reader = ? AND name = ?").get(acct, name)?.title || "";
    } catch {
      return "";
    }
  };
  return text(day, s, readerDay(r, s.skip, titleOf), site);
}

// The morning review's note, if it came this Kyiv day.
function triageToday(db, now = new Date()) {
  try {
    const t = JSON.parse(db.get("triage:last") || "null");
    return t && dayOf(t.at) === dayOf(now) ? t.text : "";
  } catch {
    return "";
  }
}

// Ready: today's run of every nightly backup has reported (good or not: a failure went to Telegram at once), and the
// review has left today's note. From DEADLINE_HOUR the report goes anyway, with what is missing.
function techReady(db, now = new Date()) {
  const nightly = backups.state(db, now).filter((x) => !backups.WEEKLY.has(x.app));
  const backed = nightly.every((x) => x.last && dayOf(x.last.at) === dayOf(now));
  return (backed && !!triageToday(db, now)) || now.getHours() >= backups.DEADLINE_HOUR;
}

async function buildTech({ db, day, ownerId, site, reader, dataDir }) {
  const rd = readerDay(await readerOf(reader, day), skipped(db, ownerId).skip);
  let siteSt = null;
  try {
    siteSt = { ...storageLib.now(dataDir, ["chytai.db"]), rss: os.totalmem() - os.freemem() }; // the machine, both processes
  } catch {}
  return techText(day, techDay(db, day), rd, site, backups.line(db), triageToday(db), storageLine(siteSt, rd?.storage), searchLine(searchDay(db, day)));
}

// In the jobs process: a look every 10 minutes; each report goes once a day (meta `dailyreport:lastRun`,
// `techreport:lastRun`).
function schedule(opts) {
  const { db } = opts;
  const tick = async () => {
    if (!telegram.on() || !telegram.chat()) return;
    const now = new Date();
    const today = dayOf(now);
    const day = addDays(today, -1);
    if (now.getHours() >= REPORT_HOUR && db.get("dailyreport:lastRun") !== today) {
      db.set("dailyreport:lastRun", today);
      try {
        await telegram.send(await build({ ...opts, day }));
      } catch (e) {
        console.error(`daily report: ${e.message}`);
      }
    }
    if (db.get("techreport:lastRun") !== today && techReady(db, now)) {
      db.set("techreport:lastRun", today);
      try {
        await telegram.send(await buildTech({ ...opts, day }));
      } catch (e) {
        console.error(`tech report: ${e.message}`);
      }
    }
  };
  setInterval(tick, 10 * 60000).unref();
  setTimeout(tick, 3 * 60000).unref();
}

module.exports = { build, buildTech, techReady, schedule, siteDay, techDay, readerDay, searchDay, searchLine, text, techText };
