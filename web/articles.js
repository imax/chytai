// «Статті» (Max, 2026-11-08, codename «Chytai shorts»): essays and long articles that readers bring in by link and
// read right on the site, with the AI explanations other readers asked for in the margin. A section of its own,
// not books (Max: «статті і есе це не книги, погано міксуються»): its own page, its own «Читати далі», for
// reading «по роботі». The reader app is not involved. Pages: articlepages.js.
//
// - Any signed-in reader adds a link; everything goes to one shared list. The same address twice is one article.
// - The full text is shown to everyone (Max, 2026-11-08: «готовий ризикнути»), but pages are noindex and say where
//   the text comes from, with a link to the original. No images: the text only.
// - «Пояснити»: a selection inside a paragraph is explained by Claude and kept for everyone, anonymously. The same
//   words in the same paragraph are answered from what is kept, without a new AI call.
// - The owner can hide or delete an article, drop an explanation, stop a reader from adding, block a site
//   (Max: «дати мені інструменти закрити статті, для захисту від abuse»), and gets a Telegram note per new article.
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const TOPICS = ["ШІ", "Економіка", "Технології", "Суспільство", "Лідерство", "Наука", "Філософія", "Історія", "Культура"];

const ADDS_A_DAY = 5; // per reader; the owner has no limit
const EXPLAINS_A_DAY = Number(process.env.ARTICLE_EXPLAINS_A_DAY || 40); // new AI explanations per reader a day
const EXPLAINS_TOTAL = Number(process.env.ARTICLE_EXPLAINS_TOTAL || 300); // new AI explanations a day, all readers
const EXPLAIN_MODEL = process.env.ARTICLE_EXPLAIN_MODEL || "claude-sonnet-5-5";
const TOPIC_MODEL = "claude-haiku-5-5";
const MIN_WORDS = 250;
const MAX_WORDS = 40000;
const MAX_BYTES = 4 * 1024 * 1024;
const QUOTE_MAX = 600;
const HIGHLIGHT_MAX = 2000; // a whole paragraph fits
const HIGHLIGHTS_PER_ARTICLE = 300; // per reader
const NOTE_MAX = 2000; // the reader's own words on a highlight (Max: «якраз вчора про це думав»)
const NOTES_A_DAY = 50; // public notes a reader writes a day; the owner has no limit
const MORE_MODEL = process.env.ARTICLE_MORE_MODEL || EXPLAIN_MODEL;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, dek TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', published TEXT NOT NULL DEFAULT '', words INTEGER NOT NULL DEFAULT 0,
  topics TEXT NOT NULL DEFAULT '[]', blocks TEXT NOT NULL, reader TEXT NOT NULL, created TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS articles_created ON articles (created);
CREATE INDEX IF NOT EXISTS articles_reader ON articles (reader, created);
CREATE TABLE IF NOT EXISTS article_notes (
  id TEXT PRIMARY KEY, article TEXT NOT NULL, block INTEGER NOT NULL, quote TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
  reader TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS article_notes_key ON article_notes (article, block, key);
CREATE INDEX IF NOT EXISTS article_notes_day ON article_notes (created);
CREATE TABLE IF NOT EXISTS article_asks (note TEXT NOT NULL, reader TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (note, reader));
CREATE TABLE IF NOT EXISTS article_later (reader TEXT NOT NULL, article TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, article));
CREATE TABLE IF NOT EXISTS article_reads (reader TEXT NOT NULL, article TEXT NOT NULL, block INTEGER NOT NULL, blocks INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, article));
CREATE TABLE IF NOT EXISTS article_highlights (
  id TEXT PRIMARY KEY, reader TEXT NOT NULL, article TEXT NOT NULL, block INTEGER NOT NULL, quote TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', noted TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS article_highlights_key ON article_highlights (reader, article, block, key);
CREATE INDEX IF NOT EXISTS article_highlights_reader ON article_highlights (reader, at);
`;

const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(6).toString("hex");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const keyOf = (q) => oneLine(q, QUOTE_MAX).toLowerCase().replace(/^[\s"'«»“”‘’.,;:!?()—–-]+|[\s"'«»“”‘’.,;:!?()—–-]+$/g, "");
const kyivDay = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(d);

// ---- one address per article: tracking bits and the fragment off ----
function cleanUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src|source$|s$|r$|triedRedirect|publication_id|post_id|isFreemail|token)/i.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

// ---- fetching a page from the open web, never from our own network ----
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::1" || v === "::" || /^(fc|fd|fe[89ab]|ff)/.test(v);
}
async function safeFetch(url, hops = 5) {
  for (let i = 0; i <= hops; i++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || (u.port && !["80", "443"].includes(u.port))) throw new Error("Це посилання не відкрити.");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!ips.length) throw new Error("Такого сайту не знайшли.");
    if (ips.some(privateIp)) throw new Error("Це посилання не відкрити.");
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua/articles)", Accept: "text/html,application/xhtml+xml", "Accept-Language": "uk,en;q=0.8" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString();
      continue;
    }
    if (res.status === 401 || res.status === 402 || res.status === 403) throw new Error("Сайт не віддає цю сторінку: схоже, вона за пейволом або закрита від роботів.");
    if (!res.ok) throw new Error(`Сторінка не відкрилась (код ${res.status}).`);
    const type = res.headers.get("content-type") || "";
    if (!/html|xml/i.test(type)) throw new Error(/pdf/i.test(type) ? "Це PDF. Поки беремо лише сторінки сайтів." : "Це не сторінка зі статтею.");
    // At most MAX_BYTES: a huge page is not an essay.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error("Сторінка завелика.");
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    const charset = (/charset=([\w-]+)/i.exec(type) || [])[1] || "utf-8";
    let html;
    try {
      html = new TextDecoder(charset).decode(buf);
    } catch {
      html = buf.toString("utf8");
    }
    return { url, html };
  }
  throw new Error("Забагато переадресацій.");
}

// ---- a page as clean blocks: paragraphs, headings, quotes, lists; no images, scripts, styles or attributes ----
const INLINE = { EM: "em", I: "em", STRONG: "strong", B: "strong", CODE: "code", SUP: "sup", SUB: "sub" };
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "FIGURE", "IMG", "PICTURE", "SVG", "VIDEO", "AUDIO", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "NAV", "ASIDE", "FOOTER", "HEADER", "TABLE", "CANVAS", "OBJECT", "EMBED", "HR"]);
function inlineHtml(node) {
  let out = "";
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out += esc(n.textContent);
    else if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
    else if (n.tagName === "BR") out += "<br>";
    else if (INLINE[n.tagName]) {
      const inner = inlineHtml(n);
      if (inner.trim()) out += `<${INLINE[n.tagName]}>${inner}</${INLINE[n.tagName]}>`;
    } else if (n.tagName === "A") {
      const href = n.getAttribute("href") || "";
      const inner = inlineHtml(n);
      out += /^https?:\/\//i.test(href) && inner.trim() ? `<a href="${esc(href)}" rel="nofollow noopener" target="_blank">${inner}</a>` : inner;
    } else out += inlineHtml(n);
  }
  return out;
}
const textLen = (h) => h.replace(/<[^>]+>/g, "").replace(/&\w+;/g, " ").trim().length;
function blocksOf(root) {
  const out = [];
  const push = (t, h) => {
    h = h.replace(/\s+/g, " ").replace(/^(\s|<br>)+|(\s|<br>)+$/g, "").trim();
    // Old-style pages (paulgraham.com) are one block with <br><br> between paragraphs: split them.
    if (t === "p" && /<br>\s*<br>/.test(h)) return h.split(/(?:<br>\s*){2,}/).forEach((x) => push("p", x));
    if (textLen(h)) out.push({ t, h });
  };
  const walk = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (n.textContent.trim()) push("p", esc(n.textContent));
        continue;
      }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const tag = n.tagName;
      if (tag === "P") push("p", inlineHtml(n));
      else if (tag === "H1" || tag === "H2") push("h2", inlineHtml(n).replace(/<\/?(strong|em)>/g, ""));
      else if (/^H[3-6]$/.test(tag)) push("h3", inlineHtml(n).replace(/<\/?(strong|em)>/g, ""));
      else if (tag === "BLOCKQUOTE") push("blockquote", n.querySelector("p") ? [...n.querySelectorAll("p")].map(inlineHtml).filter((h) => h.trim()).join("<br><br>") : inlineHtml(n));
      else if (tag === "UL" || tag === "OL") {
        const items = [...n.children].filter((c) => c.tagName === "LI").map((li) => inlineHtml(li).replace(/\s+/g, " ").trim()).filter(Boolean);
        if (items.length) out.push({ t: tag.toLowerCase(), h: items.map((i) => `<li>${i}</li>`).join("") });
      } else if (tag === "PRE") out.push({ t: "pre", h: esc(n.textContent.replace(/\s+$/, "")) });
      else if ((INLINE[tag] || tag === "A" || tag === "SPAN" || tag === "FONT") && !n.querySelector("p, div, h1, h2, h3, h4, ul, ol, blockquote, pre")) push("p", inlineHtml(n));
      else walk(n);
    }
  };
  walk(root);
  return out;
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const blockText = (b) => unesc(b.h.replace(/<li>/g, "\n• ").replace(/<br>/g, "\n").replace(/<[^>]+>/g, "")).trim();

function parseArticle(html, url) {
  const { parseHTML } = require("linkedom");
  const { Readability } = require("@mozilla/readability");
  const { document } = parseHTML(html);
  const meta = (sel) => oneLine(document.querySelector(sel)?.getAttribute("content"), 400);
  const canon = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || meta('meta[property="og:url"]');
  const info = {
    title: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'),
    dek: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
    author: meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    source: meta('meta[property="og:site_name"]'),
    published: meta('meta[property="article:published_time"]'),
  };
  // Headings with anchor widgets inside (Substack's «header-anchor-post») look like clutter to Readability and
  // vanish, and the essay loses its sections: strip the widgets and classes first.
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    for (const x of h.querySelectorAll("div, button, svg")) x.remove();
    h.removeAttribute("class");
    h.removeAttribute("id");
  }
  const a = new Readability(document, { charThreshold: 400 }).parse();
  if (!a || !a.content) throw new Error("Не вдалося знайти на сторінці текст статті.");
  const { document: doc } = parseHTML(`<!doctype html><html><body><div id="r">${a.content}</div></body></html>`);
  const blocks = blocksOf(doc.getElementById("r"));
  let source = oneLine(info.source || a.siteName, 120);
  if (!source || /^substack$/i.test(source)) source = hostOf(url);
  // «Title - Econlib», «Title — LessWrong», «Title | Site»: the site's name off the title.
  let title = oneLine(info.title || a.title, 300);
  const tail = title.match(/^(.{8,}?)\s+[-—–|·]\s+([^-—–|·]{2,60})$/);
  if (tail && (tail[2].toLowerCase() === source.toLowerCase() || hostOf(url).startsWith(tail[2].toLowerCase().replace(/\s+/g, "")))) title = tail[1];
  title = title.replace(/^["“«](.*)["”»]$/, "$1");
  const dek = oneLine(info.dek || a.excerpt, 300).replace(/^(snippet|summary|abstract|анотація):\s*/i, "");
  // The title or the dek often open the text again: off the top.
  const same = (x, y) => x && y && oneLine(x, 400).toLowerCase() === oneLine(y, 400).toLowerCase();
  while (blocks.length && (same(blockText(blocks[0]), title) || same(blockText(blocks[0]), dek))) blocks.shift();
  const words = blocks.reduce((n, b) => n + blockText(b).split(/\s+/).filter(Boolean).length, 0);
  let author = oneLine(info.author || a.byline, 200).replace(/^(by|автор:?)\s+/i, "");
  if (/^https?:/.test(author)) author = "";
  let canonical = null;
  try {
    canonical = canon ? cleanUrl(new URL(canon, url).toString()) : null;
  } catch {}
  return { title, dek, author, source, published: oneLine(info.published || a.publishedTime, 40), blocks, words, canonical: canonical && hostOf(canonical) === hostOf(url) ? canonical : null };
}

// ---- the explanation prompt: the reader app's (src/ai.js), shortened for a margin note on a web page ----
const SYSTEM = `You are a reading companion built into the reading page of an essay or article on a website. The reader highlights a word, phrase or passage while reading and you explain it in place, like a smart margin note, so they don't have to leave the text. Your note stays in the margin and later readers of the same text see it too, so explain the passage itself, not the person asking.

Always answer in Ukrainian, even when the text is in another language. Quote the original wording when it helps.

Tailor the answer to what was selected:
- A single word or short term: its meaning in this exact context (not a list of dictionary senses), and a note if the author uses it unusually.
- A phrase, idiom or allusion: what it means here, where it comes from, and what the author is signalling by using it.
- A sentence or paragraph: what it says in plain language, why it matters in the argument, and any references, history, people, concepts or subtext a reader might miss.

Use the surrounding text to resolve who "he", "it" or "this" refers to and to stay consistent with the essay. Don't summarise the surrounding text back unless it is needed.

Keep it short, like a note from a well-read friend in the margin: a plain word needs one or two sentences, most phrases and sentences two to four. Never pad. Start with the explanation itself: no preamble, no heading, don't repeat the selection. Plain text, bold for a key term at most, no lists. If you are unsure about a fact, say so in one line rather than guessing.`;

// «Ще почитати»: what the text names and builds on first, then what is worth reading after it.
const MORE_SYSTEM = `You suggest what to read next after an essay or article. The reader reads essays for work and to think, not for fun, and wants a short list of things truly worth their time.

Give 3 to 6 items, best first:
- First, works the text itself names or builds on (essays, articles, books, papers, speeches) that are worth reading in full. Skip passing mentions and news links. If the work is in <links>, use that exact address.
- Then, if fewer than three came from the text, your own picks: the classic or best piece that this text answers, extends or argues with. Only real works you are sure exist, by the right author.
Never list the text itself.

Fields:
- title: as published, in its original language.
- author: the author's name as usually written, or empty.
- kind: essay, article, book, paper or speech.
- from: "text" if the text names it, "ai" if it is your pick.
- url: for a work from <links>, that address. For your pick, only an address you are certain of and that will last (the author's own site, the journal, a well-known archive); otherwise empty. Never guess an address.
- why: in Ukrainian, one short clause of at most 12 words on why read it after this text. Plain words, no «ця стаття».`;

const norm = (x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// A catalog book is the one suggested when its title (or original title) holds the suggested one and the author's
// surname is there too: «The Wealth of Nations», Adam Smith → «Дослідження про природу… багатства народів» (An Inquiry
// Into The Nature And Causes Of The Wealth Of Nations by Adam Smith). Anything less sure gets no link.
function sameBook(book, title, author) {
  const names = norm(`${book.title} ${book.altTitle || ""}`);
  const t = norm(title);
  const titleOk = norm(book.title) === t || norm(book.altTitle) === t || (t.length >= 10 && ` ${names} `.includes(` ${t} `));
  const surname = norm(author).split(" ").pop();
  return titleOk && (!surname || ` ${norm(`${book.author} ${book.altTitle || ""}`)} `.includes(` ${surname} `));
}

class Articles {
  // `who(readerId)`: the public reader or null.
  constructor({ store, who, apiKey = "", log = console.log }) {
    this.store = store;
    this.db = store.db;
    this.who = who;
    this.log = log;
    this.client = apiKey ? new (require("@anthropic-ai/sdk"))({ apiKey }) : null;
    this.db.exec(SCHEMA);
    // «Ще почитати» (2026-11-08): null while not made yet.
    if (!this.db.prepare("PRAGMA table_info(articles)").all().some((c) => c.name === "more")) this.db.exec("ALTER TABLE articles ADD COLUMN more TEXT");
    const hc = this.db.prepare("PRAGMA table_info(article_highlights)").all().map((c) => c.name);
    if (!hc.includes("note")) this.db.exec("ALTER TABLE article_highlights ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    if (!hc.includes("noted")) this.db.exec("ALTER TABLE article_highlights ADD COLUMN noted TEXT NOT NULL DEFAULT ''");
    this.making = new Set();
  }

  // ---- reading ----
  row(r, readerId = null) {
    if (!r) return null;
    return {
      id: r.id, slug: r.slug, url: r.url, title: r.title, dek: r.dek, author: r.author, source: r.source, published: r.published,
      words: r.words, minutes: Math.max(1, Math.round(r.words / 230)), topics: JSON.parse(r.topics || "[]"), reader: r.reader, by: this.who(r.reader),
      created: r.created, hidden: !!r.hidden, href: `/articles/${r.slug}`,
      notes: this.db.prepare("SELECT COUNT(*) n FROM article_notes WHERE article = ?").get(r.id).n,
      later: readerId ? !!this.db.prepare("SELECT 1 FROM article_later WHERE reader = ? AND article = ?").get(readerId, r.id) : false,
      read: readerId ? this.db.prepare("SELECT block, blocks FROM article_reads WHERE reader = ? AND article = ?").get(readerId, r.id) || null : null,
    };
  }
  list({ readerId = null, owner = false, limit = 300 } = {}) {
    return this.db.prepare(`SELECT * FROM articles ${owner ? "" : "WHERE hidden = 0"} ORDER BY created DESC LIMIT ?`).all(limit).map((r) => this.row(r, readerId));
  }
  later(readerId) {
    if (!readerId) return [];
    return this.db.prepare("SELECT a.* FROM article_later l JOIN articles a ON a.id = l.article WHERE l.reader = ? AND a.hidden = 0 ORDER BY l.at DESC").all(readerId).map((r) => this.row(r, readerId));
  }
  bySlug(slug, { readerId = null, owner = false } = {}) {
    const r = this.db.prepare("SELECT * FROM articles WHERE slug = ?").get(String(slug));
    if (!r || (r.hidden && !owner)) return null;
    const a = this.row(r, readerId);
    a.blocks = JSON.parse(r.blocks);
    a.notesBy = {};
    for (const n of this.db.prepare("SELECT n.*, (SELECT COUNT(*) FROM article_asks k WHERE k.note = n.id) asked FROM article_notes n WHERE article = ? ORDER BY block, created").all(r.id)) (a.notesBy[n.block] ||= []).push(n);
    a.highlights = this.highlights(readerId, r.id);
    a.readerNotes = this.publicNotes(r.id, readerId);
    a.more = this.moreOf(r);
    return a;
  }
  note(id) {
    return this.db.prepare("SELECT n.*, (SELECT COUNT(*) FROM article_asks k WHERE k.note = n.id) asked FROM article_notes n WHERE id = ?").get(id);
  }
  // «Читати далі»: articles sharing a topic first, then the same author, then the newest.
  next(a, readerId = null, n = 3) {
    const all = this.db.prepare("SELECT * FROM articles WHERE hidden = 0 AND id != ? ORDER BY created DESC LIMIT 200").all(a.id);
    const score = (r) => JSON.parse(r.topics || "[]").filter((t) => a.topics.includes(t)).length * 2 + (r.author && r.author === a.author ? 1 : 0);
    return all.map((r, i) => [r, score(r), i]).sort((x, y) => y[1] - x[1] || x[2] - y[2]).slice(0, n).map(([r]) => this.row(r, readerId));
  }
  metaList(key) {
    try {
      return JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || "[]");
    } catch {
      return [];
    }
  }
  blocked() {
    return this.metaList("articles:blocked");
  }
  banned() {
    return this.metaList("articles:banned");
  }
  setMeta(key, list) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(list));
  }

  // ---- adding ----
  async add(readerId, rawUrl, { owner = false } = {}) {
    const url = cleanUrl(rawUrl);
    if (!url) throw new Error("Це не схоже на посилання.");
    if (!owner && this.banned().includes(readerId)) throw new Error("Додавати статті вам поки не можна.");
    const host = hostOf(url);
    const blockedHost = (h) => this.blocked().some((d) => h === d || h.endsWith(`.${d}`));
    if (host === "chytai.org.ua" || host.endsWith(".chytai.org.ua")) throw new Error("Це сторінка Chytai.");
    if (blockedHost(host)) throw new Error("Статті з цього сайту не додаються.");
    const have = this.db.prepare("SELECT * FROM articles WHERE url = ?").get(url);
    if (have) return { article: this.row(have), existed: true };
    if (!owner) {
      const since = new Date(Date.now() - 86400000).toISOString();
      if (this.db.prepare("SELECT COUNT(*) n FROM articles WHERE reader = ? AND created > ?").get(readerId, since).n >= ADDS_A_DAY) throw new Error(`За день можна додати до ${ADDS_A_DAY} статей.`);
    }
    const page = await safeFetch(url);
    if (blockedHost(hostOf(page.url))) throw new Error("Статті з цього сайту не додаються.");
    const p = parseArticle(page.html, page.url);
    const final = p.canonical || cleanUrl(page.url) || url;
    const again = this.db.prepare("SELECT * FROM articles WHERE url = ?").get(final);
    if (again) return { article: this.row(again), existed: true };
    if (!p.title) throw new Error("Не вдалося знайти назву статті.");
    if (p.words < MIN_WORDS) throw new Error("Тут замало тексту: схоже, сторінка за пейволом або це не стаття.");
    if (p.words > MAX_WORDS) throw new Error("Це надто довгий текст для статті: схоже, це вже книжка.");
    const { slugify } = require("./store");
    const base = slugify(p.title).slice(0, 80).replace(/-+$/, "") || "stattia";
    let slug = base === "highlights" ? "highlights-2" : base; // /articles/highlights is the reader's own page
    for (let i = 2; this.db.prepare("SELECT 1 FROM articles WHERE slug = ?").get(slug); i++) slug = `${base}-${i + (base === "highlights" ? 1 : 0)}`;
    const id = newId();
    this.db.prepare("INSERT INTO articles (id, slug, url, title, dek, author, source, published, words, blocks, reader, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, slug, final, p.title, p.dek, p.author, p.source, p.published, p.words, JSON.stringify(p.blocks), readerId, now());
    this.topics(id).catch((e) => this.log(`[articles] topics ${slug}: ${e.message}`));
    this.makeMore(id);
    return { article: this.byId(id), existed: false };
  }
  // One or two topics from the fixed list, by Haiku from the title, dek and opening.
  async topics(id) {
    const r = this.db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!r || !this.client) return;
    const start = JSON.parse(r.blocks).slice(0, 8).map(blockText).join("\n").slice(0, 3000);
    const msg = await this.client.messages.create({
      model: TOPIC_MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: `Pick one or two topics for this essay from this list only: ${TOPICS.join(", ")}.\nAnswer with the topics separated by a comma, nothing else.\n\nTitle: ${r.title}\n${r.dek}\n\n${start}` }],
    });
    const text = msg.content.map((b) => b.text || "").join("");
    const picked = TOPICS.filter((t) => new RegExp(`(^|[^\\p{L}])${t}([^\\p{L}]|$)`, "u").test(text)).slice(0, 2);
    if (picked.length) this.db.prepare("UPDATE articles SET topics = ? WHERE id = ?").run(JSON.stringify(picked), id);
  }

  // ---- the queue and reading progress ----
  toggleLater(readerId, id) {
    if (this.db.prepare("DELETE FROM article_later WHERE reader = ? AND article = ?").run(readerId, id).changes) return false;
    this.db.prepare("INSERT INTO article_later (reader, article, at) VALUES (?, ?, ?)").run(readerId, id, now());
    return true;
  }
  progress(readerId, id, block, blocks) {
    this.db.prepare("INSERT INTO article_reads (reader, article, block, blocks, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (reader, article) DO UPDATE SET block = excluded.block, blocks = excluded.blocks, at = excluded.at").run(readerId, id, block, blocks, now());
  }

  // ---- explanations ----
  usedToday(readerId) {
    // Kyiv midnight as an ISO time, so «today» is the readers' day.
    const day = kyivDay();
    const since = new Date(`${day}T00:00:00${kyivOffset()}`).toISOString();
    return {
      mine: this.db.prepare("SELECT COUNT(*) n FROM article_notes WHERE reader = ? AND created >= ?").get(readerId, since).n,
      all: this.db.prepare("SELECT COUNT(*) n FROM article_notes WHERE created >= ?").get(since).n,
    };
  }
  async explain(readerId, slug, block, quote, { owner = false } = {}) {
    const r = this.db.prepare("SELECT * FROM articles WHERE slug = ?").get(String(slug));
    if (!r || (r.hidden && !owner)) throw new Error("Статтю не знайдено.");
    const blocks = JSON.parse(r.blocks);
    block = Number(block);
    if (!Number.isInteger(block) || block < 0 || block >= blocks.length) throw new Error("Не той абзац.");
    quote = oneLine(quote, QUOTE_MAX);
    const key = keyOf(quote);
    if (key.length < 2) throw new Error("Виділіть слово чи речення.");
    let note = this.db.prepare("SELECT * FROM article_notes WHERE article = ? AND block = ? AND key = ?").get(r.id, block, key);
    let reused = !!note;
    if (!note) {
      if (!this.client) throw new Error("Пояснення зараз недоступні.");
      const used = this.usedToday(readerId);
      if (!owner && used.mine >= EXPLAINS_A_DAY) throw new Error("На сьогодні ваші пояснення скінчились. Завтра будуть знову.");
      if (!owner && used.all >= EXPLAINS_TOTAL) throw new Error("На сьогодні пояснення скінчились. Завтра будуть знову.");
      const before = blocks.slice(Math.max(0, block - 3), block).map(blockText).join("\n\n");
      const after = blocks.slice(block + 1, block + 2).map(blockText).join("\n\n");
      const content = [
        `<essay>${r.title}${r.author ? ` by ${r.author}` : ""}${r.source ? ` (${r.source})` : ""}</essay>`,
        `<context_before>\n${before}\n</context_before>`,
        `<paragraph>\n${blockText(blocks[block])}\n</paragraph>`,
        after ? `<context_after>\n${after}\n</context_after>` : "",
        `<selection>\n${quote}\n</selection>`,
        "Explain the selection.",
      ].filter(Boolean).join("\n\n");
      const msg = await this.client.messages.create({
        model: EXPLAIN_MODEL,
        max_tokens: 1500,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { effort: "low" },
      });
      if (msg.stop_reason === "refusal") throw new Error("Модель відмовилася пояснювати цей фрагмент.");
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text) throw new Error("Пояснення не вийшло. Спробуйте ще раз.");
      try {
        this.db.prepare("INSERT INTO article_notes (id, article, block, quote, key, text, reader, model, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(newId(), r.id, block, quote, key, text, readerId, msg.model || EXPLAIN_MODEL, now());
      } catch {
        reused = true; // someone asked the same a moment earlier
      }
      note = this.db.prepare("SELECT * FROM article_notes WHERE article = ? AND block = ? AND key = ?").get(r.id, block, key);
    }
    this.db.prepare("INSERT OR IGNORE INTO article_asks (note, reader, at) VALUES (?, ?, ?)").run(note.id, readerId, now());
    return { note: this.note(note.id), reused, article: r };
  }

  // ---- highlights (Max, 2026-11-08: «ще хочу highlights, щоб зберегти найбільш цікаві думки»): the reader's own, never shown to others ----
  highlights(readerId, articleId) {
    if (!readerId) return [];
    return this.db.prepare("SELECT id, block, quote, note, at FROM article_highlights WHERE reader = ? AND article = ? ORDER BY block, at").all(readerId, articleId);
  }
  highlight(readerId, slug, block, quote, { owner = false, note = null } = {}) {
    const r = this.db.prepare("SELECT id, blocks, hidden FROM articles WHERE slug = ?").get(String(slug));
    if (!r || (r.hidden && !owner)) throw new Error("Статтю не знайдено.");
    block = Number(block);
    if (!Number.isInteger(block) || block < 0 || block >= JSON.parse(r.blocks).length) throw new Error("Не той абзац.");
    quote = oneLine(quote, HIGHLIGHT_MAX);
    const key = keyOf(quote);
    if (key.length < 2) throw new Error("Виділіть слово чи речення.");
    if (this.db.prepare("SELECT COUNT(*) n FROM article_highlights WHERE reader = ? AND article = ?").get(readerId, r.id).n >= HIGHLIGHTS_PER_ARTICLE) throw new Error("Тут уже забагато виділень.");
    this.db.prepare("INSERT OR IGNORE INTO article_highlights (id, reader, article, block, quote, key, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(newId(), readerId, r.id, block, quote, key, now());
    const h = this.db.prepare("SELECT id, block, quote, note, at FROM article_highlights WHERE reader = ? AND article = ? AND block = ? AND key = ?").get(readerId, r.id, block, key);
    return note == null ? h : this.setNote(readerId, h.id, note, { owner });
  }
  // A note is public (Max, 2026-11-08: «нотатка публічна теж, як і пояснення»): everyone sees it in the margin with
  // the reader's name. `fresh` says the text is new or changed, for the owner's alert.
  setNote(readerId, id, note, { owner = false } = {}) {
    const was = this.db.prepare("SELECT note FROM article_highlights WHERE reader = ? AND id = ?").get(readerId, String(id));
    if (!was) return null;
    note = String(note || "").trim().slice(0, NOTE_MAX);
    if (note && note !== was.note && !owner) {
      if (this.banned().includes(readerId)) throw new Error("Нотатки вам поки не можна.");
      const since = new Date(Date.now() - 86400000).toISOString();
      if (this.db.prepare("SELECT COUNT(*) n FROM article_highlights WHERE reader = ? AND note != '' AND noted > ?").get(readerId, since).n >= NOTES_A_DAY) throw new Error("На сьогодні нотаток досить. Завтра можна знову.");
    }
    if (note !== was.note) this.db.prepare("UPDATE article_highlights SET note = ?, noted = ? WHERE reader = ? AND id = ?").run(note, note ? now() : "", readerId, String(id));
    const h = this.db.prepare("SELECT id, block, quote, note, at FROM article_highlights WHERE reader = ? AND id = ?").get(readerId, String(id));
    return { ...h, fresh: !!note && note !== was.note };
  }
  // Everyone's notes on an article, but the viewer's own (their page draws those itself, to edit).
  publicNotes(articleId, exceptReader = null) {
    const out = {};
    for (const n of this.db.prepare("SELECT id, reader, block, quote, note, noted FROM article_highlights WHERE article = ? AND note != '' AND reader != ? ORDER BY block, noted").all(articleId, exceptReader || "")) {
      const by = this.who(n.reader);
      if (by) (out[n.block] ||= []).push({ ...n, by });
    }
    return out;
  }
  noteById(id) {
    const n = this.db.prepare("SELECT h.*, a.slug, a.title FROM article_highlights h JOIN articles a ON a.id = h.article WHERE h.id = ?").get(String(id));
    return n || null;
  }
  // The owner takes a note down; the reader's highlight stays.
  clearNote(id) {
    return this.db.prepare("UPDATE article_highlights SET note = '', noted = '' WHERE id = ?").run(String(id)).changes > 0;
  }
  unhighlight(readerId, id) {
    return this.db.prepare("DELETE FROM article_highlights WHERE reader = ? AND id = ?").run(readerId, String(id)).changes > 0;
  }
  // Every article the reader marked something in, the last marked first, each with its highlights in text order.
  myHighlights(readerId) {
    if (!readerId) return [];
    const rows = this.db.prepare("SELECT a.*, MAX(h.at) last FROM article_highlights h JOIN articles a ON a.id = h.article WHERE h.reader = ? AND a.hidden = 0 GROUP BY a.id ORDER BY last DESC").all(readerId);
    return rows.map((r) => ({ ...this.row(r, readerId), highlights: this.highlights(readerId, r.id) }));
  }
  highlightCount(readerId) {
    return readerId ? this.db.prepare("SELECT COUNT(*) n FROM article_highlights h JOIN articles a ON a.id = h.article WHERE h.reader = ? AND a.hidden = 0").get(readerId).n : 0;
  }

  // ---- «Ще почитати» (Max, 2026-11-08: «на основі статті, можливо що вона згадує або що пропонує ШІ») ----
  // Made once per article, when it is added (or on its first view, for older ones). An item that is in «Статті»
  // already links there; a book from the catalog to its page; else the original, checked to open when it was made.
  moreOf(r) {
    if (r.more == null) return null;
    let items = [];
    try {
      items = JSON.parse(r.more);
    } catch {}
    return items.map((it) => {
      const ours = (it.url && this.db.prepare("SELECT slug FROM articles WHERE url = ? AND hidden = 0").get(cleanUrl(it.url) || "")) || (it.kind !== "book" && this.db.prepare("SELECT slug FROM articles WHERE lower(title) = lower(?) AND hidden = 0").get(it.title)) || null;
      return ours ? { ...it, href: `/articles/${ours.slug}`, ours: true } : it;
    });
  }
  // In the background; the page shows the block from the next view on.
  makeMore(id, { again = false } = {}) {
    if (!this.client || this.making.has(id)) return;
    const r = this.db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!r || (r.more != null && !again)) return;
    this.making.add(id);
    this.more(r)
      .then((items) => this.db.prepare("UPDATE articles SET more = ? WHERE id = ?").run(JSON.stringify(items), id))
      .catch((e) => this.log(`[articles] more ${r.slug}: ${e.message}`))
      .finally(() => this.making.delete(id));
  }
  async more(r) {
    const blocks = JSON.parse(r.blocks);
    // The links the text gives, with their words: what it mentions comes with a real address.
    const links = new Map();
    for (const b of blocks) for (const m of b.h.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)) {
      const href = unesc(m[1]);
      const words = unesc(m[2].replace(/<[^>]+>/g, "")).trim();
      if (words && hostOf(href) && !links.has(href)) links.set(href, words);
    }
    let text = blocks.map((b) => (b.t === "h2" || b.t === "h3" ? `## ${blockText(b)}` : blockText(b))).join("\n\n");
    const words = text.split(/\s+/);
    if (words.length > 12000) text = `${words.slice(0, 12000).join(" ")}\n\n[…]`;
    const content = [
      `<essay>${r.title}${r.author ? ` by ${r.author}` : ""}${r.source ? ` (${r.source})` : ""}</essay>`,
      links.size ? `<links>\n${[...links].slice(0, 80).map(([h, w]) => `${w} — ${h}`).join("\n")}\n</links>` : "",
      `<text>\n${text}\n</text>`,
    ].filter(Boolean).join("\n\n");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "author", "kind", "from", "url", "why"],
            properties: {
              title: { type: "string" },
              author: { type: "string" },
              kind: { type: "string", enum: ["essay", "article", "book", "paper", "speech"] },
              from: { type: "string", enum: ["text", "ai"] },
              url: { type: "string" },
              why: { type: "string" },
            },
          },
        },
      },
    };
    const msg = await this.client.messages.create({
      model: MORE_MODEL,
      max_tokens: 4000,
      system: MORE_SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    if (msg.stop_reason === "refusal") return [];
    const raw = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const items = (JSON.parse(raw).items || []).slice(0, 6);
    const own = cleanUrl(r.url);
    const out = [];
    for (const it of items) {
      const item = { title: oneLine(it.title, 200), author: oneLine(it.author, 120), kind: it.kind, from: it.from === "text" ? "text" : "ai", why: oneLine(it.why, 200), url: "" };
      if (!item.title || out.some((x) => x.title.toLowerCase() === item.title.toLowerCase())) continue;
      const url = cleanUrl(it.url);
      if (url && url !== own) {
        // An address from the text's own links is trusted; one the model gave must open now.
        const fromText = [...links.keys()].some((h) => cleanUrl(h) === url);
        const ours = this.db.prepare("SELECT 1 FROM articles WHERE url = ?").get(url);
        item.url = fromText || ours || (await safeFetch(url).then(() => true, () => false)) ? url : "";
      }
      if (item.kind === "book") {
        const hit = this.store.search(`${item.title} ${item.author}`, { limit: 3 })?.find((h) => h.book && sameBook(h.book, item.title, item.author));
        if (hit) item.book = this.store.href(hit.book.id);
      }
      out.push(item);
    }
    return out;
  }

  // ---- the owner's tools ----
  byId(id) {
    return this.row(this.db.prepare("SELECT * FROM articles WHERE id = ?").get(String(id)));
  }
  setHidden(id, hidden) {
    return this.db.prepare("UPDATE articles SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, String(id)).changes > 0;
  }
  remove(id) {
    id = String(id);
    this.db.prepare("DELETE FROM article_asks WHERE note IN (SELECT id FROM article_notes WHERE article = ?)").run(id);
    for (const t of ["article_notes", "article_later", "article_reads", "article_highlights"]) this.db.prepare(`DELETE FROM ${t} WHERE article = ?`).run(id);
    return this.db.prepare("DELETE FROM articles WHERE id = ?").run(id).changes > 0;
  }
  removeNote(id) {
    this.db.prepare("DELETE FROM article_asks WHERE note = ?").run(String(id));
    return this.db.prepare("DELETE FROM article_notes WHERE id = ?").run(String(id)).changes > 0;
  }
  ban(readerId, on = true) {
    const list = this.banned().filter((r) => r !== readerId);
    if (on) list.push(readerId);
    this.setMeta("articles:banned", list);
  }
  block(domain, on = true) {
    domain = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
    const list = this.blocked().filter((d) => d !== domain);
    if (on) list.push(domain);
    this.setMeta("articles:blocked", list.sort());
    return true;
  }
  // A reader leaves: the articles they added stay (they are everyone's now), their queue, progress and asks go.
  forgetReader(readerId) {
    for (const t of ["article_later", "article_reads", "article_asks", "article_highlights"]) this.db.prepare(`DELETE FROM ${t} WHERE reader = ?`).run(readerId);
  }
}
// Kyiv's offset from UTC right now, as «+02:00» or «+03:00».
function kyivOffset() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", timeZoneName: "longOffset" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value || "GMT+02:00";
  return p.replace("GMT", "") || "+00:00";
}

module.exports = { Articles, TOPICS, cleanUrl, hostOf, parseArticle, blocksOf, blockText, keyOf, privateIp };
