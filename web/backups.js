// Are the nightly backups there? (Max, 2026-11-11: «перевіряти, що бекап кожну ніч працює. Не так, як зараз, щоб
// випадково дізналися, що його немає». That morning the site's backup had failed, and only GitHub's e-mail said so.)
//
// .github/workflows/backup.yml ends every job (site, reader) with POST /agent/backup: what it took, whether the
// copy came back from the encrypted artifact (scripts/backup-restore-check.sh) and which step failed. Kept here in
// meta `backup:<app>` (the last report) and `backup:<app>:ok` (the last good one).
// Telegram, few lines: a failed job says so at once; a copy much smaller than the night before says so; and when a
// Kyiv day has no good copy of an app by DEADLINE_HOUR (the run never started, or its report never came), the jobs
// process says that once that day. GitHub starts the 03:30 run late on busy nights (2026-11-11: 08:54 Kyiv), hence noon.
// The same state is a row of «Performance» on /admin, a line of the morning report and `backups` in /agent/health.
const telegram = require("./telegram");

const APPS = { "chytai-web": "сайту", chytai: "Читалки" }; // «бекап сайту»
const SHORT = { "chytai-web": "сайт", chytai: "Читалка" };
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

// A report from the workflow: { app, ok, failed: [step], files, bytes, restored, test, run }.
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
    run: /^https:\/\/github\.com\/imax\/chytai\/actions\/runs\/\d+/.test(String(body.run || "")) ? String(body.run) : "",
  };
  const prev = read(db, `backup:${app}:ok`);
  db.set(`backup:${app}`, JSON.stringify(r));
  if (r.ok) db.set(`backup:${app}:ok`, JSON.stringify(r));
  const name = APPS[app];
  let text = "";
  if (!r.ok) text = `Бекап ${name} не вдався${r.failed.length ? `: ${r.failed.join(", ")}` : ""}.`;
  else if (prev && (r.files < prev.files / 2 || r.bytes < prev.bytes / 2)) text = `Бекап ${name} підозріло малий: ${r.files} файлів, ${mb(r.bytes)} (попередній ${prev.files}, ${mb(prev.bytes)}).`;
  else if (r.test === "failed") text = `Бекап ${name} є, але тестова копія бази не вийшла: треди тестують на вчорашній.`;
  else if (!r.restored) text = `Бекап ${name} є, але відновити його для перевірки не вдалося.`;
  if (text) await telegram.send(`${text}\n${r.run || ACTIONS}`);
  return { kept: r, told: !!text };
}

// Each app: its last report, its last good copy, and whether that is fresh enough now.
// Fresh: a good copy made this Kyiv day, or before DEADLINE_HOUR one from the day before.
function state(db, now = new Date()) {
  const today = kyivDay(now);
  const yesterday = kyivDay(now.getTime() - DAY);
  return Object.entries(APPS).map(([app, name]) => {
    const last = read(db, `backup:${app}`);
    const ok = read(db, `backup:${app}:ok`);
    const day = ok ? kyivDay(ok.at) : null;
    const fresh = day === today || (kyivHour(now) < DEADLINE_HOUR && day === yesterday);
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

// One line of the morning report (08:00 Kyiv, before the deadline: a late run is not a failure yet).
function line(db) {
  const one = (x) => `${SHORT[x.app]} ${x.last && !x.last.ok && kyivDay(x.last.at) === kyivDay(Date.now()) ? "не вдався" : x.today ? "✓" : "ще нема"}`;
  return `Бекап за ніч: ${state(db).map(one).join(", ")}`;
}

// In the jobs process: from DEADLINE_HOUR, an app without today's good copy is said once that day.
function watch(db) {
  const tick = () => {
    if (kyivHour() < DEADLINE_HOUR) return;
    const late = state(db).filter((x) => !x.fresh && x.last); // an app that never reported is red on /admin, not here
    if (!late.length) return;
    const text = `Сьогодні нема бекапу ${late.map((x) => x.name).join(" і ")}: останній ${late.map((x) => (x.ok ? hhmm(x.ok.at) : "ніколи")).join(" і ")}. Запустити: ${ACTIONS} → Run workflow.`;
    telegram.sendOnce(`backup-late:${kyivDay(Date.now())}`, 48, text);
  };
  setInterval(tick, 10 * 60000).unref();
  setTimeout(tick, 2 * 60000).unref();
}

module.exports = { record, state, row, line, watch, DEADLINE_HOUR };
