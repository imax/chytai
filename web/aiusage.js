// What Claude costs, per Kyiv day, feature and model, for the site and the reader together (Max, 2026-11-15:
// «давай подумаємо щоб рахувати теж токени, щоб бачити якщо десь починається перерозхід»; «додавати витрати за
// добу в технічний звіт»; «$25 в день»).
// - The site: server/aimeter.js counts every answer of every Claude call in both processes into `ai_usage`
//   (app 'site'; feature = the file that called: advice, ask, aipass…).
// - The reader counts its own the same way (state.stats.days[day].ai) and gives them with /api/site-admin/day; the
//   jobs process copies them here every hour (app 'reader'), so one table has the history of both.
// - check(), hourly in the jobs process: one Telegram line when the day passes DAY_ALERT dollars, or a feature spends
//   twice its median of the 7 days before and more than FEATURE_MIN (that one would have caught the overview loop
//   of 2026-11, ~$15 a day). Each at most once a day.
// - line(): «AI за добу» in the technical report (dailyreport.js).
// The Anthropic console stays the truth: it also sees calls this code does not make. Rows kept KEEP_DAYS.
const aimeter = require("../server/aimeter");
const telegram = require("./telegram");

const DAY_ALERT = 25; // dollars a day, both apps (Max, 2026-11-15)
const FEATURE_MIN = 3; // a feature's day must cost more than this to be «twice its norm»
const KEEP_DAYS = 400;
const DAY = 86400000;

const LABELS = {
  "site:advice": "Відгуки в інтернеті",
  "site:ask": "Порадити книжки (/ask)",
  "site:aipass": "AI-проходи по каталогу",
  "site:catalogpasses": "AI-проходи по каталогу",
  "site:newbooks": "Перевірка нових книжок",
  "site:ukfind": "Пошук українських видань",
  "site:bookpage": "Книжка за посиланням",
  "site:tgfeed": "Події з Telegram",
  "site:uktrial": "Проби",
  "site:langtrial": "Проби",
  "site:origtrial": "Проби",
  "site:genretrial": "Проби",
  "site:overviewtrial": "Проби",
  "reader:ai": "Читалка: пояснення й переклад",
  "reader:paper": "Читалка: паперові книжки",
  "reader:content": "Читалка: перевірка завантажень",
};
const label = (app, feature) => LABELS[`${app}:${feature}`] || (app === "reader" ? `Читалка: ${feature}` : feature);

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}; // the process's time zone (Europe/Kyiv on Fly), as admin.js
const addDays = (day, n) => dayOf(new Date(`${day}T12:00:00`).getTime() + n * DAY);
const money = (x) => `$${x >= 10 ? Math.round(x) : x.toFixed(2)}`;

let db = null;
let put = null;

function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT NOT NULL, app TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, app, feature, model))`);
  put = db.prepare(`INSERT INTO ai_usage (day, app, feature, model, calls, input, output, cache_read, cache_write, searches, cost)
    VALUES (@day, @app, @feature, @model, @calls, @input, @output, @cacheRead, @cacheWrite, @searches, @cost)
    ON CONFLICT (day, app, feature, model) DO UPDATE SET calls = calls + excluded.calls, input = input + excluded.input,
    output = output + excluded.output, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
    searches = searches + excluded.searches, cost = cost + excluded.cost`);
  aimeter.install((r) => record(r));
  db.prepare("DELETE FROM ai_usage WHERE day < ?").run(addDays(dayOf(Date.now()), -KEEP_DAYS));
}

// One answer of the site's (aimeter's row), added to today's.
function record(r, app = "site", day = dayOf(Date.now())) {
  if (!put) return;
  put.run({ day, app, feature: r.feature || "?", model: r.model || "?", calls: r.calls || 0, input: r.input || 0, output: r.output || 0, cacheRead: r.cacheRead || 0, cacheWrite: r.cacheWrite || 0, searches: r.searches || 0, cost: r.cost || 0 });
}

// The reader's counts for a day ({ feature: { model: row } }, its /api/site-admin/day `ai`) replace what we had.
function syncReader(day, ai) {
  if (!db || !ai || typeof ai !== "object") return;
  const tx = db.tx || ((fn) => fn());
  tx(() => {
    db.prepare("DELETE FROM ai_usage WHERE day = ? AND app = 'reader'").run(day);
    for (const [feature, models] of Object.entries(ai)) for (const [model, r] of Object.entries(models || {})) record({ feature, model, ...r }, "reader", day);
  });
}

// The day by feature (both apps), dearest first: [{ app, feature, label, calls, input, output, cost }].
function byFeature(day) {
  if (!db) return [];
  return db
    .prepare("SELECT app, feature, SUM(calls) calls, SUM(input + cache_read + cache_write) input, SUM(output) output, SUM(searches) searches, SUM(cost) cost FROM ai_usage WHERE day = ? GROUP BY app, feature ORDER BY cost DESC")
    .all(day)
    .map((r) => ({ ...r, label: label(r.app, r.feature) }));
}

// Labels can join two files (the trials): one row per label.
function byLabel(day) {
  const m = new Map();
  for (const r of byFeature(day)) {
    const o = m.get(r.label) || { label: r.label, calls: 0, input: 0, output: 0, cost: 0 };
    for (const k of ["calls", "input", "output", "cost"]) o[k] += r[k];
    m.set(r.label, o);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

// «AI за добу: $4.10 (Відгуки в інтернеті $2.30, Читалка: пояснення й переклад $1.40, інше $0.40)».
function line(day) {
  const rows = byLabel(day);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  if (!rows.length) return "AI за добу: викликів не було.";
  const top = rows.slice(0, 3).filter((r) => r.cost >= 0.01);
  const rest = total - top.reduce((s, r) => s + r.cost, 0);
  const parts = top.map((r) => `${r.label} ${money(r.cost)}`);
  if (rest >= 0.01) parts.push(`інше ${money(rest)}`);
  return `AI за добу: ${money(total)}${total >= DAY_ALERT ? ", понад норму" : ""}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// What should be told now: [{ key, text }]. Pure on the table; check() sends.
function alarms(day) {
  const out = [];
  const rows = byLabel(day);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  if (total > DAY_ALERT) {
    const top = rows.slice(0, 3).map((r) => `${r.label} ${money(r.cost)}`).join(", ");
    out.push({ key: `ai:day:${day}`, text: `AI сьогодні вже ${money(total)}, більше за $${DAY_ALERT}: ${top}.` });
  }
  const before = Array.from({ length: 7 }, (_, i) => new Map(byLabel(addDays(day, i - 7)).map((r) => [r.label, r.cost])));
  for (const r of rows) {
    if (r.cost <= FEATURE_MIN) continue;
    const norm = median(before.map((m) => m.get(r.label) || 0));
    if (r.cost > 2 * norm) out.push({ key: `ai:feature:${day}:${r.label}`, text: `AI: «${r.label}» сьогодні ${money(r.cost)} (${r.calls} викликів), звично ${money(norm)} на день.` });
  }
  return out;
}

// Hourly in the jobs process: the reader's counts for today (and yesterday's last hour), then the alarms.
async function check(reader) {
  const today = dayOf(Date.now());
  for (const day of [addDays(today, -1), today]) {
    try {
      const r = await reader(day);
      if (r?.ai) syncReader(day, r.ai);
    } catch (e) {
      console.error(`aiusage: reader ${day}: ${e.message}`);
    }
  }
  for (const a of alarms(today)) await telegram.sendOnce(a.key, 24, a.text);
}

function schedule(reader) {
  const tick = () => check(reader).catch((e) => console.error(`aiusage: ${e.message}`));
  setInterval(tick, 3600000).unref();
  setTimeout(tick, 5 * 60000).unref();
}

module.exports = { init, record, syncReader, byFeature, byLabel, line, alarms, check, schedule, label, DAY_ALERT };
