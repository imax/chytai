// A book from its page on a store's or a publisher's site (a reader's ask, 2026-10-23: «дати йому лінк і
// сказати дивись, ось ця книжка, підтягни її»). For a Ukrainian book that neither our catalog nor Open
// Library has, the reader pastes the address of its page (Сенс, Yakaboo, a publisher) on /add and gets the
// title, the author, the cover and the publisher's annotation. The page is read once by the server: its
// Open Graph and schema.org marks first; Claude (Haiku) then reads the marks and the start of the page text
// and says what the book is, because stores put the author anywhere («Книга X, Автор - купити»,
// «X. Автор», a table of characteristics). Without an API key the marks alone are used.
// Only public http(s) addresses on the internet are fetched, never the server's own network.
const dns = require("dns").promises;
const net = require("net");

const MODEL = "claude-haiku-5-5";
const TIMEOUT = 10000;
const MAX_BYTES = 3e6;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua)", Accept: "text/html,application/xhtml+xml", "Accept-Language": "uk,en;q=0.8" };
const DAY = 86400000;
const PER_READER = 40; // pages a reader may ask about a day; a cached page is free

const isUrl = (s) => /^https?:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(String(s || "").trim());

// Loopback, private, link-local, carrier-grade NAT and the like: the server's own neighbourhood.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}
async function publicHost(host) {
  if (/^(localhost|.*\.(local|internal|localhost|flycast))$/i.test(host)) return false;
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return ips.length > 0 && !ips.some(privateIp);
}

// The page's HTML, following up to four redirects, each checked again.
async function getPage(url, fetchImpl, check = publicHost) {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !(await check(u.hostname))) throw new Error("not a public address");
    const res = await fetchImpl(u.href, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), u).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/html|xml/i.test(res.headers.get("content-type") || "text/html")) throw new Error("not a web page");
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      if ((size += value.length) > MAX_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    return { html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), url: u.href, status: res.status, type: res.headers.get("content-type") || "", server: res.headers.get("server") || "" };
  }
  throw new Error("too many redirects");
}

const ENTITIES = { quot: '"', amp: "&", nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…", lt: "<", gt: ">", apos: "'", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
const unescape = (s) => String(s || "").replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
const squash = (s) => unescape(s).replace(/\s+/g, " ").trim();

// What the page says about itself: meta tags, schema.org JSON-LD and microdata, and its visible text.
function marks(html, url) {
  const meta = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in meta)) meta[key] = squash(content[1] ?? content[2]);
  }
  const ld = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (x) => (Array.isArray(x) ? x.forEach(walk) : x && typeof x === "object" && (x["@graph"] ? walk(x["@graph"]) : ld.push(x)));
      walk(JSON.parse(m[1]));
    } catch {}
  }
  const item = ld.find((x) => /Book/i.test([].concat(x["@type"]).join())) || ld.find((x) => /Product/i.test([].concat(x["@type"]).join())) || null;
  const name = (v) => [].concat(v || []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean).join(", ");
  const image = (v) => [].concat(v || []).map((i) => (typeof i === "string" ? i : i?.url || i?.contentUrl)).find(Boolean) || "";
  const abs = (u) => {
    try {
      return u ? new URL(unescape(u), url).href : "";
    } catch {
      return "";
    }
  };
  const title = squash(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
  const h1 = squash((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || "").replace(/<[^>]+>/g, " "));
  // The visible text from the heading on, where a product page keeps its name, characteristics and annotation.
  let body = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ");
  const at = body.search(/<h1[\s>]/i);
  if (at > 0) body = body.slice(at);
  const text = squash(body.replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")).slice(0, 6000);
  return {
    url,
    // «Сенс — інтернет-магазин любові до книги» is «Сенс»; a long name without a short part is the address.
    site: ((n) => (n && n.length <= 30 ? n : new URL(url).hostname.replace(/^www\./, "")))(String(meta["og:site_name"] || "").split(/\s+[—–|-]\s+/)[0].trim()),
    title: item?.name ? squash(item.name) : meta["og:title"] || h1 || title,
    pageTitle: title,
    h1,
    author: squash(name(item?.author) || meta["book:author"] || meta["author"] || ""),
    cover: abs(image(item?.image) || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["image"]),
    description: squash(item?.description || meta["og:description"] || meta["description"] || ""),
    isbn: String(item?.isbn || meta["book:isbn"] || meta["isbn"] || "").replace(/[^0-9X]/gi, ""),
    published: Number(String(item?.datePublished || meta["book:release_date"] || "").slice(0, 4)) || null,
    pages: Number(item?.numberOfPages) || null,
    text,
  };
}

// Without Claude: the marks as they are, with the shop's words taken off the title («Книга X - купити …»)
// and an author at its end («X. Мішель Фуко», «X, Мішель Фуко») taken out when the marks name none.
function plain(m) {
  let title = m.title.replace(/^(книга|книжка|книги)\s+/i, "").replace(/\s+[-–—|]\s+(купити|купить|buy)\b.*$/i, "").replace(/\s*[|]\s*[^|]*$/, "").trim();
  let author = m.author;
  if (!author) {
    const tail = /(?:[.,]|\s[-–—])\s+(\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,2})$/u.exec(title);
    if (tail) [title, author] = [title.slice(0, tail.index).trim(), tail[1]];
  }
  return { title, author, description: m.description, isbn: m.isbn, published: m.published, pages: m.pages };
}

const SYSTEM = `You read a book's page on a store's or a publisher's website and say which book it is. Answer with one JSON object and nothing else:
{"book": true|false, "title": "...", "author": "...", "isbn": "...", "year": 2024, "pages": 320, "annotation": "..."}
- book: false when the page is not about one book (a category, a cart, a search, a main page, a 404).
- title: the book's title as printed on it, in the page's language, with its subtitle after a period or colon when the page gives one. No "Книга", no author, no format, edition, cover type, price or store words.
- author: the author(s) in the usual order (first name, then surname), as the page writes them, comma-separated; the translator, illustrator or publisher is not an author. Empty for an anthology without one.
- isbn, year (of this edition), pages: when the page says them, else null.
- annotation: the publisher's description of the book exactly as the page has it, without reviews, characteristics, delivery or price; at most 1200 characters, cut at a sentence end; empty if there is none.`;

class BookPage {
  constructor({ apiKey = "", fetchImpl = fetch, check = publicHost, log = () => {} } = {}) {
    this.client = apiKey ? new (require("@anthropic-ai/sdk"))({ apiKey }) : null;
    this.fetchImpl = fetchImpl;
    this.check = check;
    this.log = log;
    this.cache = new Map(); // url -> { at, book }
    this.asked = new Map(); // reader -> { day, n }
  }

  // Can this reader ask about one more page today? Pages already read don't count.
  allowed(reader, url) {
    if (this.cache.has(url)) return true;
    const day = new Date().toISOString().slice(0, 10);
    const a = this.asked.get(reader);
    return !a || a.day !== day || a.n < PER_READER;
  }

  // fromUrl(url, reader) -> { title, author, cover, blurb, isbns, published, pages, url, site } or { error }.
  async fromUrl(url, reader = "", { debug = false } = {}) {
    url = String(url || "").trim();
    if (!isUrl(url)) return { error: "Це не схоже на адресу сторінки." };
    const hit = !debug && this.cache.get(url);
    if (hit && Date.now() - hit.at < DAY) return hit.book;
    if (!this.allowed(reader, url)) return { error: "На сьогодні досить посилань, спробуйте завтра або заповніть вручну." };
    const day = new Date().toISOString().slice(0, 10);
    const a = this.asked.get(reader);
    this.asked.set(reader, a && a.day === day ? { day, n: a.n + 1 } : { day, n: 1 });
    let m;
    try {
      const page = await getPage(url, this.fetchImpl, this.check);
      m = marks(page.html, page.url);
      if (debug) m.raw = { status: page.status, type: page.type, server: page.server, size: page.html.length, head: page.html.slice(0, 600) };
    } catch (e) {
      this.log(`bookpage ${url}: ${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message}`);
      if (debug) return { debug: { error: `${e.name}: ${e.cause?.code || ""} ${e.message}` } };
      return { error: `Не вдалося відкрити сторінку на ${new URL(url).hostname.replace(/^www\./, "")}. Спробуйте посилання з іншого магазину або заповніть вручну.` };
    }
    // A page with nothing on it is a gate in front of the site (Сенс answers servers with a script that sets
    // a cookie and reloads): we don't go round it, the reader fills the book in by hand.
    if (!m.title && m.text.length < 200) {
      this.log(`bookpage ${url}: empty page, ${m.text.length} chars`);
      return this.keep(url, { error: `Сайт ${new URL(m.url).hostname.replace(/^www\./, "")} не показує сторінку нашому серверу. Спробуйте посилання з іншого магазину або заповніть вручну.` });
    }
    let info = plain(m);
    if (this.client) {
      try {
        const ask = { url: m.url, site: m.site, title: m.pageTitle, h1: m.h1, marks: { title: m.title, author: m.author, description: m.description, isbn: m.isbn }, text: m.text };
        const res = await this.client.messages.create({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(ask) }] });
        const out = res.content.map((c) => c.text || "").join("");
        if (debug) return { debug: { marks: { ...m, text: m.text.slice(0, 1500) }, claude: out } };
        const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
        if (j.book === false) return this.keep(url, { error: "На цій сторінці не видно однієї книжки. Вставте посилання на сторінку самої книжки." });
        info = { title: squash(j.title) || info.title, author: squash(j.author), description: squash(j.annotation) || info.description, isbn: String(j.isbn || info.isbn || "").replace(/[^0-9X]/gi, ""), published: Number(j.year) || info.published, pages: Number(j.pages) || info.pages };
      } catch (e) {
        this.log(`bookpage ${url}: Claude ${e.message}`);
      }
    }
    if (!info.title) return this.keep(url, { error: "Не знайшли на сторінці назви книжки. Заповніть вручну." });
    return this.keep(url, {
      title: info.title.slice(0, 200),
      author: (info.author || "").slice(0, 200),
      cover: /^https:\/\//.test(m.cover) ? m.cover : "",
      blurb: (info.description || "").slice(0, 1500),
      isbns: /^(\d{9}[\dX]|\d{13})$/.test(info.isbn) ? [info.isbn] : [],
      published: info.published && info.published > 1400 && info.published <= new Date().getFullYear() + 1 ? info.published : null,
      pages: info.pages > 0 && info.pages < 10000 ? info.pages : null,
      url: m.url,
      site: m.site.slice(0, 60),
    });
  }

  keep(url, book) {
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(url, { at: Date.now(), book });
    return book;
  }
}

module.exports = { BookPage, isUrl, marks, plain, privateIp };
