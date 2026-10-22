// «Огляди»: links to reviews and videos about a book on its page, added by hand: by any signed-in reader
// from the book page (Max, 2026-10-22: «зробити цю форму відкритою для читачів, як у нас було з Додати
// книжку»), and by the owner on /admin/reviews (link + book). The automatic collection from sites and
// BookTube was tried the same morning and dropped («повна шляпа»).
// Only a link, its title, the site, the date and one sentence are shown, never the text itself: a
// quote with its source is free to use, a copy of a review is not (Закон 2811-IX).
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "uk,en;q=0.5" };

const SCHEMA = `CREATE TABLE IF NOT EXISTS reviews (
  url TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, date TEXT, quote TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', works TEXT NOT NULL DEFAULT '[]', seen TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', added_by TEXT NOT NULL DEFAULT ''
);`;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
const decode = (s) => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const plain = (html) => decode(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const kindOf = (url) => (/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url) ? "youtube" : "site");

// The sentence shown under a link: the first sentence of the page's description, at most 200 characters.
function quoteOf(text) {
  const t = plain(text);
  if (t.length < 25) return "";
  const sentence = (t.match(/^.{25,}?[.!?…](?=\s|$)/) || [t])[0];
  return sentence.length <= 200 ? sentence : sentence.slice(0, 200).replace(/\s+\S*$/, "") + "…";
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// What a page says about itself: title, site, first sentence, date (YouTube through oEmbed).
async function describe(url) {
  const it = { title: url, name: new URL(url).hostname.replace(/^www\./, ""), date: null, quote: "" };
  if (kindOf(url) === "youtube") {
    const o = JSON.parse(await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`));
    // oEmbed has no date; the video's own page has it, when YouTube lets a server read it.
    const id = (url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
    const page = id ? await get(`https://www.youtube.com/watch?v=${id}`).catch(() => "") : "";
    const date = (page.match(/"(?:publishDate|uploadDate)":"(\d{4}-\d\d-\d\d)/) || [])[1] || null;
    return { ...it, title: o.title || it.title, name: o.author_name || "YouTube", date };
  }
  const html = await get(url);
  const meta = (p) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)`, "i")) || [])[1] || "");
  const title = meta("og:title") || plain((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const date = meta("article:published_time") || meta("datePublished");
  return { ...it, title: title || it.title, name: meta("og:site_name") || it.name, quote: quoteOf(meta("og:description") || meta("description")), date: /^\d{4}-\d\d-\d\d/.test(date) ? date.slice(0, 10) : null };
}

class Reviews {
  constructor(store, { log = console.log } = {}) {
    this.store = store;
    this.db = store.db;
    this.log = log;
    this.db.exec(SCHEMA);
    const cols = this.db.prepare("PRAGMA table_info(reviews)").all().map((c) => c.name);
    if (!cols.includes("name")) this.db.exec("ALTER TABLE reviews ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("added_by")) this.db.exec("ALTER TABLE reviews ADD COLUMN added_by TEXT NOT NULL DEFAULT ''"); // the reader who added it
    // What the dropped collection brought in and nobody added (2026-10-22) goes, with its bookkeeping.
    if (!this.db.get("reviews:collected-removed")) {
      const kept = new Set(Object.values(this.picks()).flat());
      for (const r of this.db.prepare("SELECT url FROM reviews WHERE source != 'manual'").all()) if (!kept.has(r.url)) this.db.prepare("DELETE FROM reviews WHERE url = ?").run(r.url);
      this.db.exec("DELETE FROM meta WHERE key LIKE 'reviews:%' AND key != 'reviews:picks'");
      this.db.set("reviews:collected-removed", new Date().toISOString());
    }
  }
  picks() {
    return JSON.parse(this.db.get("reviews:picks") || "{}"); // work id -> [url], in the order added
  }
  row(url) {
    return this.db.prepare("SELECT url, name, title, date, quote, added_by AS by FROM reviews WHERE url = ?").get(url);
  }
  // A work's links, in the order added.
  of(workId) {
    const urls = this.picks()[this.store.canonical(workId)] || [];
    return urls.map((u) => this.row(u)).filter(Boolean).map((r) => ({ ...r, source: r.name, kind: kindOf(r.url) }));
  }
  // Every link with its book, the last added first, for /admin/reviews.
  all() {
    const out = [];
    for (const [id, urls] of Object.entries(this.picks())) {
      const book = this.store.book(id);
      for (const u of urls) {
        const r = this.db.prepare("SELECT url, name, title, date, quote, seen, added_by AS by FROM reviews WHERE url = ?").get(u);
        if (r && book) out.push({ ...r, source: r.name, kind: kindOf(r.url), book });
      }
    }
    return out.sort((a, b) => String(b.seen).localeCompare(String(a.seen)));
  }
  // date: when the review came out (YYYY-MM-DD) if given; else the page's own, else none. by: who adds it;
  // a link already here keeps its date unless its own reader or the owner gives a new one.
  async add(url, workId, { date = "", by = "", owner = false } = {}) {
    url = String(url).trim();
    date = /^\d{4}-\d\d-\d\d$/.test(date) ? date : "";
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error("Це не схоже на посилання.");
    const id = this.store.canonical(workId);
    const known = this.row(url);
    if (!known) {
      let it = { title: url, name: new URL(url).hostname.replace(/^www\./, ""), date: null, quote: "" };
      try {
        it = await describe(url);
      } catch (e) {
        this.log(`reviews: ${url}: ${e.message}`); // kept with the address as its title
      }
      this.db.prepare("INSERT INTO reviews (url, source, name, title, date, quote, works, seen, added_by) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)").run(url, it.name, it.title.slice(0, 300), date || it.date || null, it.quote, JSON.stringify([id]), new Date().toISOString(), String(by));
    } else if (date && (owner || known.by === String(by))) this.setDate(url, date);
    const all = this.picks();
    all[id] = [...(all[id] || []).filter((u) => u !== url), url];
    this.db.set("reviews:picks", JSON.stringify(all));
  }
  setDate(url, date) {
    this.db.prepare("UPDATE reviews SET date = ? WHERE url = ?").run(/^\d{4}-\d\d-\d\d$/.test(date) ? date : null, url);
  }
  remove(workId, url) {
    const id = this.store.canonical(workId);
    const all = this.picks();
    all[id] = (all[id] || []).filter((u) => u !== url);
    if (!all[id].length) delete all[id];
    this.db.set("reviews:picks", JSON.stringify(all));
  }
}

module.exports = { Reviews, quoteOf };
