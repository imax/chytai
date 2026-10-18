// «Що почитати»: Claude reads the owner's rated books (titles, ratings, genres, a line of each
// note) and suggests books that are not in the library yet, optionally on a topic. Results are
// cached per topic on disk so a page view costs nothing until «Оновити».
const fs = require("fs");
const path = require("path");

const MODEL = process.env.RECOMMEND_MODEL || "claude-opus-5-5";
const TOPICS = ["Фантастика", "Історія", "Бізнес і компанії", "Українська література", "Біографії", "Щось зовсім інше"];

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function profileText(store) {
  const rows = store.library().filter((r) => r.status === "read");
  const line = (r) => {
    const note = (r.note || "").replace(/\*\*/g, "").replace(/\[(.+?)\]\(.+?\)/g, "$1").split(/\n/)[0].slice(0, 160);
    return `- ${r.book.title}${r.book.author ? ` (${r.book.author})` : ""}${r.rating != null ? ` — ${r.rating}/5` : ""}${r.year ? ` [${r.year}]` : ""}${(r.book.tags || []).length ? ` {${r.book.tags.join(", ")}}` : ""}${note ? `: ${note}` : ""}`;
  };
  return rows.map(line).join("\n");
}

function cacheFile(store) {
  return path.join(path.dirname(store.file), "recommend.json");
}
function readCache(store) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(store), "utf8"));
  } catch {
    return {};
  }
}

async function ask(store, topic) {
  const api = anthropic();
  if (!api) throw new Error("ANTHROPIC_API_KEY не налаштований, рекомендації недоступні.");
  const have = store.library().map((r) => r.book.title);
  const system = `Ти книжковий порадник для одного читача. Нижче його прочитані книжки з оцінками (5/5 найкраще) і короткими нотатками українською. Порадь 8 книжок, яких у списку немає, і які йому найімовірніше сподобаються. Орієнтуйся на оцінки 4,5–5 і на те, що він пише в нотатках; не раджи банальні бестселери, які він напевно вже знає, і не раджи книжок російських авторів. Українські переклади чи українські автори мають перевагу, коли вони доречні. Відповідай лише JSON-масивом об'єктів {"title","author","year","why"} без іншого тексту; "why" це 1–2 речення українською, з посиланням на конкретні книжки з його списку, через які ти це радиш.`;
  const user = `${topic ? `Тема: ${topic}.\n\n` : "Тема: без обмежень, будь-який жанр.\n\n"}Прочитані книжки:\n${profileText(store)}\n\nУ бібліотеці вже є (не радити): ${have.join("; ")}`;
  const res = await api.messages.create({ model: MODEL, max_tokens: 2500, system, messages: [{ role: "user", content: user }] });
  const text = res.content.map((c) => c.text || "").join("");
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  const items = JSON.parse(json);
  return { items, model: MODEL, at: new Date().toISOString().slice(0, 16).replace("T", " "), usage: res.usage };
}

async function recommend({ store, user, topic, refresh, pages }) {
  const key = topic.trim().toLowerCase() || "*";
  const cache = readCache(store);
  let result = cache[key];
  let error = "";
  if (!result || refresh) {
    try {
      result = await ask(store, topic.trim());
      cache[key] = result;
      fs.writeFileSync(cacheFile(store), JSON.stringify(cache, null, 1));
    } catch (e) {
      error = e.message;
    }
  }
  return pages.layout({ title: "Що почитати", user, path: "/recommend", body: recommendBody({ topic, result, error, pages, store }) });
}

function recommendBody({ topic, result, error, pages, store }) {
  const { esc } = pages;
  const items = result?.items || [];
  const inLib = new Map(store.library().map((r) => [r.book.title.toLowerCase(), r]));
  return `
<section class="head">
  <div>
    <h1>Що почитати</h1>
    <p class="muted">Claude дивиться на твої оцінки й нотатки і радить, чого ще немає в бібліотеці.</p>
  </div>
</section>
<section class="toolbar">
  <form method="get" action="/recommend" class="chips">
    <a class="chip ${!topic ? "on" : ""}" href="/recommend">Будь-що</a>
    ${TOPICS.map((t) => `<a class="chip ${topic === t ? "on" : ""}" href="/recommend?topic=${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}
    <input type="search" name="topic" value="${esc(topic)}" placeholder="Своя тема, наприклад «про Японію»">
    <button class="btn">Порадити</button>
  </form>
</section>
${error ? `<p class="empty">${esc(error)}</p>` : ""}
${items.length ? `<section class="recs">
${items.map((it) => {
    const have = inLib.get(String(it.title).toLowerCase());
    return `<article class="rec">
  <h3>${esc(it.title)}${it.year ? ` <span class="muted small">${esc(it.year)}</span>` : ""}</h3>
  <p class="by">${esc(it.author || "")}</p>
  <p>${esc(it.why || "")}</p>
  ${have ? `<p class="small have">Вже в бібліотеці</p>` : `<form method="post" action="/api/book" class="inline"><input type="hidden" name="title" value="${esc(it.title)}"><input type="hidden" name="author" value="${esc(it.author || "")}"><input type="hidden" name="status" value="want"><button class="btn small">Хочу прочитати</button></form>`}
</article>`;
  }).join("\n")}
</section>
<p class="muted small">Поради від ${esc(result.model)}, ${esc(result.at)}. <a href="/recommend?topic=${encodeURIComponent(topic)}&refresh">Оновити</a></p>` : !error ? `<p class="muted">Поки порад немає.</p>` : ""}`;
}

module.exports = { recommend };
