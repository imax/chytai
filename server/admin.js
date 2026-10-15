// Admin dashboard (/admin): who reads, what they read and how many explanations Claude has produced.
// Pure rendering: index.js collects the numbers (collectStats) and this file turns them into HTML.

// $ per million tokens: [input, output, cache read, cache write]. Rough, for a sense of scale only.
const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES).find((k) => model.startsWith(k));
  return base ? PRICES[base] : null;
}

// Cost in USD of one { input, output, cacheRead, cacheWrite } token record; null when the model is unknown.
function cost(model, t) {
  const p = priceFor(model);
  if (!p) return null;
  return (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite * p[3]) / 1e6;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (v) => Number(v || 0).toLocaleString("uk-UA");
const usd = (v) => (v == null ? "—" : v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(2)}`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;

function ago(ts) {
  if (!ts) return "—";
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 2) return "щойно";
  if (min < 60) return `${min} хв тому`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} год тому`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} дн тому` : new Date(ts).toLocaleDateString("uk-UA");
}

function tile(label, value, note) {
  return `<div class="tile"><div class="v">${value}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${note}</div>` : ""}</div>`;
}

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function adminPage(s) {
  const totals = s.totals;
  const costTotal = s.models.reduce((sum, m) => (sum == null || m.cost == null ? null : sum + m.cost), 0);
  const cost30 = s.days.slice(0, 30).reduce((sum, d) => (sum == null || d.cost == null ? null : sum + d.cost), 0);

  const users = table(
    ["Хто", "Пояснень сьогодні", "За 7 днів", "Усього", "Книжок почато", "Остання активність", "Остання книжка"],
    s.users.map((u) => [esc(u.name), n(u.today), n(u.week), n(u.total), n(u.started), esc(ago(u.lastSeen)), esc(u.lastBook || "—")]),
    "Ще ніхто не входив."
  );
  const books = table(
    ["Книжка", "Автор", "Читачів", "Розмір"],
    s.books.map((b) => [esc(b.title), esc(b.authors), n(b.readers), mb(b.size)]),
    "У бібліотеці ще немає книжок."
  );
  const days = table(
    ["День", "Пояснень", "Родина", "Гості", "Токенів на вході", "На виході", "≈ Вартість"],
    s.days.slice(0, 30).map((d) => [esc(d.day), n(d.explains), n(d.family), n(d.guests), n(d.input + d.cacheRead + d.cacheWrite), n(d.output), usd(d.cost)]),
    "Пояснень ще не було."
  );
  const models = table(
    ["Модель", "Запитів", "Токенів на вході", "На виході", "≈ Вартість"],
    s.models.map((m) => [esc(m.model), n(m.requests), n(m.input + m.cacheRead + m.cacheWrite), n(m.output), usd(m.cost)]),
    "Пояснень ще не було."
  );

  const w = s.wishes || { rows: [], total: 0, lists: 0 };
  const wishes = table(
    ["Книжка", "Автор", "Хто хоче", "Скільки", "Додано", "У бібліотеці"],
    w.rows.map((r) => [esc(r.title), esc(r.author || "—"), esc(r.who.join(", ")), n(r.who.length), esc(ago(r.addedAt)), r.inLibrary ? "є" : "немає"]),
    "Ще ніхто нічого не записав у «Хочу прочитати»."
  );
  const missing = w.rows.filter((r) => !r.inLibrary).length;

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai · адмін</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; --bg: #f6efe0; --fg: #3b2f1e; --card: rgba(255,255,255,0.55); --muted: rgba(59,47,30,0.6); --accent: #b7791f; --line: rgba(0,0,0,0.1); }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e20; --fg: #e6e6e6; --card: #2a2a2d; --muted: rgba(230,230,230,0.6); --line: rgba(255,255,255,0.12); } }
  body { margin: 0; padding: 20px 16px 40px; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 960px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { margin: 0; font-size: 22px; } header a { color: var(--accent); font-weight: 600; text-decoration: none; }
  header .when { color: var(--muted); font-size: 13px; margin-left: auto; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  .tile { padding: 14px 16px; border-radius: 14px; background: var(--card); box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
  .tile .v { font-size: 26px; font-weight: 700; line-height: 1.2; } .tile .l { color: var(--muted); font-size: 13px; margin-top: 2px; } .tile .n { color: var(--muted); font-size: 12px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; font-size: 14px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  tr:last-child td { border-bottom: none; } td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th:not(:first-child) { text-align: right; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 12px; }
  .empty, .note { color: var(--muted); font-size: 13px; }
</style></head>
<body><main>
  <header><h1>Chytai · статистика</h1><a href="/">← до читалки</a><span class="when">${esc(new Date().toLocaleString("uk-UA", { timeZone: s.timeZone }))}</span></header>
  <div class="tiles">
    ${tile("Читачів у родині", n(s.users.length), s.users.filter((u) => u.activeWeek).length ? `${n(s.users.filter((u) => u.activeWeek).length)} за тиждень` : "")}
    ${tile("Гостей сьогодні", n(s.guestsToday), `${n(s.guestExplainsToday)} із ${n(s.guestTotalLimit)} пояснень`)}
    ${tile("Книжок", n(s.books.length), mb(s.books.reduce((a, b) => a + b.size, 0)))}
    ${tile("Пояснень сьогодні", n(totals.today))}
    ${tile("За 7 днів", n(totals.week))}
    ${tile("Усього", n(totals.all), `з ${esc(s.since || "сьогодні")}`)}
    ${tile("≈ Вартість за 30 днів", usd(cost30), costTotal != null ? `усього ${usd(costTotal)}` : "")}
    ${tile("Хочуть прочитати", n(w.rows.length), w.rows.length ? `${n(missing)} ще немає в бібліотеці` : "")}
  </div>
  <p class="note">Пояснення рахуються з ${esc(s.since || "сьогодні")}: кожен запит до Claude (пояснення, «Детальніше», уточнення) — один. Вартість приблизна, за тарифами API без знижок; вхідні токени включають кеш.</p>

  <h2>Читачі</h2><div class="wrap">${users}</div>
  <h2>Книжки</h2><div class="wrap">${books}</div>
  <h2>Хочу прочитати</h2>
  ${w.total ? `<p class="note">${n(w.total)} записів у ${n(w.lists)} читачів. Зверху те, що хоче більше людей і чого ще немає в бібліотеці.</p>` : ""}
  <div class="wrap">${wishes}</div>
  <h2>По днях</h2><div class="wrap">${days}</div>
  <h2>Моделі</h2><div class="wrap">${models}</div>
</main></body></html>`;
}

module.exports = { adminPage, cost };
