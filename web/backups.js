// Are the nightly backups there? (Max, 2026-11-11: «перевіряти, що бекап кожну ніч працює. Не так, як зараз, щоб
// випадково дізналися, що його немає». That morning the site's backup had failed, and only GitHub's e-mail said so.)
//
// .github/workflows/backup.yml ends every job (site, reader) with POST /agent/backup: what it took, whether the
// copy came back from the encrypted artifact (scripts/backup-restore-check.sh) and which step failed. Kept here in
// meta `backup:<app>` (the last report) and `backup:<app>:ok` (the last good one).
// Telegram, few lines: a failed job says so at once; a copy much smaller than the night before says so. The day's
// technical report (dailyreport.js) waits for the night's reports and goes at DEADLINE_HOUR at the latest, saying
// which copy has not come (the run never started, or its report never came). GitHub starts the 03:30 run late on busy
// nights (2026-11-11: 08:54 Kyiv), hence noon.
// The same state is a row of «Performance» on /admin, the first line of the technical report and `backups` in /agent/health.
// Our own covers (web/covers, ~180 MB) are copied apart once a week (Max, 2026-11-11: «поки у нас маленький сайт і
// база, то і бекап теж має бути маленьким, а ці великі штуки винесемо окремо»): fresh within WEEKLY_DAYS.
const telegram = require("./telegram");

const APPS = { "chytai-web": "сайту", chytai: "Читалки", "chytai-web-covers": "обкладинок" }; // «бекап сайту»
const SHORT = { "chytai-web": "сайт", chytai: "Читалка", "chytai-web-covers": "обкладинки" };
const WEEKLY = new Set(["chytai-web-covers"]);
const WEEKLY_DAYS = 8;
const DEADLINE_HOUR = 12; // Kyiv
// The workflow's step ids (backup.yml), as Max reads them.
const STEPS = { snap: "знімок на машині", check: "перевірка копії", encrypt: "шифрування", upload: "збереження в GitHub", download: "завантаження назад", restore: "пробне відновлення", test: "тестова копія" };
const ACTIONS = "https://github.com/imax/chytai/actions/workflows/backup.yml";
const DAY = 86400000;

const kyivHour = (t = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Kyiv" }).format(t));
const kyivDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(t)); // YYYY-MM-DD
const hhmm = (t) => new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t)).replace(",", "");
const mb = (b) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0).replace(".", ",")} МБ`;
const read = (db, key) => {
  try {
    return JSON.parse(db.get(key) || "null");
  } catch {
    return null;
  }
};

// A report from the workflow: { app, ok, failed: [step], files, bytes, restored, test, run, shape }. `shape` names
// what the copy leaves out; sizes are compared only between copies of one shape, and only with one that restored
// (2026-11-11 a copy of the covers came down as the site's: it is no measure for the next one).
// Answers what was kept, and sends a line to Telegram when something is wrong.
async function record(db, body = {}) {
  const app = String(body.app || "");
  if (!APPS[app]) throw new Error(`app: ${Object.keys(APPS).join(" | ")}`);
  const r = {
    at: new Date().toISOString(),
    ok: body.ok === true,
    failed: (Array.isArray(body.failed) ? body.failed : []).map((x) => STEPS[x] || String(x).slice(0, 40)).slice(0, 10),
    files: Number(body.files) || 0,
    bytes: Number(body.bytes) || 0,
    restored: body.restored === true,
    test: ["ok", "failed", "skipped"].includes(body.test) ? body.test : null,
    shape: String(body.shape || "").slice(0, 200),
    run: /^https:\/\/github\.com\/imax\/chytai\/actions\/runs\/\d+/.test(String(body.run || "")) ? String(body.run) : "",
  };
  const prev = read(db, `backup:${app}:ok`);
  db.set(`backup:${app}`, JSON.stringify(r));
  if (r.ok) db.set(`backup:${app}:ok`, JSON.stringify(r));
  const name = APPS[app];
  let text = "";
  if (!r.ok) text = `Бекап ${name} не вдався${r.failed.length ? `: ${r.failed.join(", ")}` : ""}.`;
  else if (prev?.restored && (prev.shape || "") === r.shape && r.bytes < prev.bytes / 2) text = `Бекап ${name} підозріло малий: ${r.files} файлів, ${mb(r.bytes)} (попередній ${prev.files}, ${mb(prev.bytes)}).`;
  else if (r.test === "failed") text = `Бекап ${name} є, але тестова копія бази не вийшла: треди тестують на вчорашній.`;
  else if (!r.restored) text = `Бекап ${name} є, але відновити його для перевірки не вдалося.`;
  if (text) await telegram.send(`${text}\n${r.run || ACTIONS}`);
  return { kept: r, told: !!text };
}

// Each app: its last report, its last good copy, and whether that is fresh enough now.
// Fresh: a good copy made this Kyiv day, or before DEADLINE_HOUR one from the day before; a weekly one within WEEKLY_DAYS.
function state(db, now = new Date()) {
  const today = kyivDay(now);
  const yesterday = kyivDay(now.getTime() - DAY);
  return Object.entries(APPS).map(([app, name]) => {
    const last = read(db, `backup:${app}`);
    const ok = read(db, `backup:${app}:ok`);
    const day = ok ? kyivDay(ok.at) : null;
    const fresh = WEEKLY.has(app) ? !!ok && now - Date.parse(ok.at) < WEEKLY_DAYS * DAY : day === today || (kyivHour(now) < DEADLINE_HOUR && day === yesterday);
    return { app, name, fresh, today: day === today, last, ok };
  });
}

// A row of «Performance» on /admin: [ok, good text, bad text] as healthBlock takes it.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function row(db) {
  const s = state(db);
  const bad = s.filter((x) => !x.fresh || (x.last && !x.last.ok));
  const one = (x) => `${SHORT[x.app]} ${x.ok ? `${hhmm(x.ok.at)}${x.ok.restored ? "" : " (не перевірений)"}` : "ще жодного"}`;
  const why = (x) =>
    x.last && !x.last.ok
      ? `бекап ${x.name} не вдався ${hhmm(x.last.at)}${x.last.failed?.length ? ` (${esc(x.last.failed.join(", "))})` : ""}`
      : `бекапу ${x.name} нема з ${x.ok ? hhmm(x.ok.at) : "початку"}`;
  const bads = bad.map(why).join("; ");
  return [!bad.length, `Бекапи свіжі й відновлюються: ${s.map(one).join(", ")}.`, `${bads.replace(/^./, (c) => c.toUpperCase())}. <a href="${ACTIONS}">Actions</a>`];
}

// The first line of the technical report: sent when the night's copies have reported, or at DEADLINE_HOUR without them.
function line(db, now = new Date()) {
  const late = kyivHour(now) >= DEADLINE_HOUR;
  const one = (x) => `${SHORT[x.app]} ${x.last && !x.last.ok && kyivDay(x.last.at) === kyivDay(now) ? "не вдався" : x.today ? "✓" : late ? "нема" : "ще нема"}`;
  const s = state(db, now);
  const weekly = s.filter((x) => WEEKLY.has(x.app) && x.last && !x.fresh).map((x) => `${SHORT[x.app]} не оновлювались з ${x.ok ? hhmm(x.ok.at).split(" ")[0] : "початку"}`);
  const bad = s.some((x) => (!WEEKLY.has(x.app) && !x.today) || (x.last && !x.last.ok)) || weekly.length;
  return `Бекап за ніч: ${[...s.filter((x) => !WEEKLY.has(x.app)).map(one), ...weekly].join(", ")}${bad ? `\n${ACTIONS}` : ""}`;
}

module.exports = { record, state, row, line, DEADLINE_HOUR, WEEKLY };
