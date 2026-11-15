// «Книжкові події» on /calendar (Max, 2026-11-15: «давай зробимо календар книжкових подій»; design A + D from a
// design canvas): presentations, readings and festivals, a list by days, with a line on the author's and the
// book's pages. An event always leads to the organizer's page (we sell nothing) and, where we can tell, to its
// books and authors in the catalog.
//
// Where events come from (`source`):
//   - seed: web/seed/calendar.json, kept in step at every start (festivals and the like, by a thread or Max);
//   - reader: «Додати подію» on /calendar/add (a signed-in reader; Max hears of each one, like any UGC);
//   - ye: Книгарня «Є»'s public calendar (book-ye.com.ua/calendar/<city>/), read once a day by the jobs process,
//     only once switched on (meta calendar:ye = "on"); `yeRun({ dry: true })` shows what it would keep;
//   - anything else a collector brings (the Telegram thread): `upsert({ source, key, ... })`.
// An event is gone 30 days after it ended. No AI anywhere here: books and authors are found by their names.
const dns = require("dns").promises;
const net = require("net");

const KEEP_DAYS = 30;
const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const WEEKDAYS = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П’ятниця", "Субота"];
const UA = "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua)";

const SCHEMA = `CREATE TABLE IF NOT EXISTS cal_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', place TEXT NOT NULL DEFAULT '', starts TEXT NOT NULL, ends TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '', books TEXT NOT NULL DEFAULT '[]', authors TEXT NOT NULL DEFAULT '[]',
  by TEXT NOT NULL DEFAULT '', added TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cal_events_starts ON cal_events (starts);`;

// Cities by the stem of their name, so «у Києві», «Львові», «м. Рівне» are found too; the first form is shown.
const CITIES = [
  ["Київ", /київ|києв/i],
  ["Львів", /львів|львов/i],
  ["Харків", /харків|харков/i],
  ["Одеса", /одес/i],
  ["Дніпро", /дніпр(?!ов)/i],
  ["Запоріжжя", /запоріж/i],
  ["Вінниця", /вінниц/i],
  ["Рівне", /рівн(е|ому)(?![а-яіїєґ])/i],
  ["Луцьк", /луцьк/i],
  ["Тернопіль", /тернопіл|тернопол/i],
  ["Івано-Франківськ", /франківськ/i],
  ["Ужгород", /ужгород/i],
  ["Мукачево", /мукачев/i],
  ["Чернівці", /чернівц/i],
  ["Житомир", /житомир/i],
  ["Хмельницький", /хмельницьк/i],
  ["Полтава", /полтав/i],
  ["Черкаси", /черкас/i],
  ["Чернігів", /чернігів|чернігов/i],
  ["Суми", /(?<![а-яіїєґ])сум(и|ах)(?![а-яіїєґ])/i],
  ["Миколаїв", /миколаїв|миколаєв/i],
  ["Кропивницький", /кропивницьк/i],
  ["Біла Церква", /біл(а|ій) церкв/i],
  ["Кривий Ріг", /крив(ий|ому) ро?ріг|кривому розі/i],
];
const ONLINE = /онлайн|online|zoom|youtube|трансляці/i;
const findCity = (text) => (ONLINE.test(text || "") ? "Онлайн" : CITIES.find(([, re]) => re.test(text || ""))?.[0] || "");

// Today in Kyiv, «YYYY-MM-DD».
const kyivDay = (t = Date.now()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(new Date(t));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");

// The date (and time) an event's text names: «4 вересня 18:30», «19–20 листопада 2026», «17 лютого о 19:00»,
// «20.11.2026», «2026-11-20T18:30». A date without a year is this year's, or next year's when it has passed by
// more than half a year. → { starts, ends, time } or null.
function parseWhen(text, today = kyivDay()) {
  const t = String(text || "");
  const year = (d, m, y) => {
    if (y) return +y;
    const ty = +today.slice(0, 4);
    return `${ty}-${pad(m)}-${pad(d)}` < addDays(today, -180) ? ty + 1 : ty;
  };
  const day = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
  let starts = null,
    ends = "",
    rest = t;
  const iso = /(20\d\d)-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/.exec(t);
  const words = new RegExp(`(\\d{1,2})(?:\\s*[-–—]\\s*(\\d{1,2}))?\\s+(${MONTHS.join("|")})(?:\\s+(20\\d\\d))?`, "i").exec(t);
  const dots = /\b(\d{1,2})\.(\d{1,2})(?:\.(20\d\d))?\b(?![.:]\d)/.exec(t);
  if (iso) {
    starts = day(+iso[1], +iso[2], +iso[3]);
    if (iso[4]) return starts && { starts, ends, time: `${iso[4]}:${iso[5]}` };
    rest = t.slice(iso.index + iso[0].length);
  } else if (words) {
    const m = MONTHS.indexOf(words[3].toLowerCase()) + 1;
    const y = year(+words[1], m, words[4]);
    starts = day(y, m, +words[1]);
    if (words[2]) ends = day(y, m, +words[2]) || "";
    rest = t.slice(words.index + words[0].length);
  } else if (dots) {
    const y = year(+dots[1], +dots[2], dots[3]);
    starts = day(y, +dots[2], +dots[1]);
    rest = t.slice(dots.index + dots[0].length);
  }
  if (!starts) return null;
  const tm = /(?:^|[^\d])(?:о\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/.exec(rest) || /(?:^|[^\d])(?:о\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/.exec(t.replace(/\b\d{1,2}\.\d{1,2}\.20\d\d\b/g, ""));
  return { starts, ends: ends > starts ? ends : "", time: tm ? `${pad(+tm[1])}:${tm[2]}` : "" };
}

// The authors (slugs) and books (work ids) an event's text names. An author: a Cyrillic name whose first name
// and surname both start words of the text (surnames change their endings: «Макса Кідрука», «Жадана»). A book:
// a title in «» quotes that the catalog has, by one of those authors when there are any.
function linkText(store, text) {
  const out = { authors: [], books: [] };
  const t = String(text || "");
  if (!t || !store?.authors) return out;
  const words = t.toLowerCase().replace(/[’'ʼ`]/g, "").match(/[\p{L}-]+/gu) || [];
  const starts = (stem) => stem.length >= 3 && words.some((w) => w.startsWith(stem));
  const stem = (w) => (w.length >= 5 ? w.replace(/[аяоеєіиїйьую]$/, "") : w);
  for (const a of store.authors.list) {
    const name = (a.uk || a.name || "").toLowerCase().replace(/[’'ʼ`]/g, "");
    if (!/[а-яіїєґ]/.test(name)) continue;
    const parts = name.split(/\s+/).filter((p) => p.length > 1 && !p.endsWith("."));
    if (parts.length < 2) continue;
    const [first, last] = [parts[0], parts[parts.length - 1]];
    if (starts(stem(last)) && starts(first.slice(0, Math.min(4, first.length)))) out.authors.push(a.slug);
  }
  const names = out.authors.map((s) => store.authors.bySlug.get(s)?.name).filter(Boolean);
  for (const m of t.matchAll(/«([^»]{2,120})»/g)) {
    const title = m[1].trim();
    const id = (names.length ? names.map((n) => store.findWork({ title, author: n })).find(Boolean) : null) || store.findWork({ title });
    if (id && !out.books.includes(id)) out.books.push(id);
    if (out.books.length >= 4) break;
  }
  // A book's authors count too: «Розмова про «Доцю»» names Тамара Горіха Зерня through her book.
  for (const id of out.books) for (const a of store.authors.list) if (a.ids.includes(id) && !out.authors.includes(a.slug)) out.authors.push(a.slug);
  out.authors = out.authors.slice(0, 6);
  return out;
}

// A page fetched from outside, for «Заповнити з посилання» and the Є calendar: only http(s) on a public address,
// 8 s, 1 MB at most.
const privateIp = (ip) =>
  net.isIPv4(ip)
    ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
    : /^(::1?$|f[cd]|fe[89ab]|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip);
async function fetchPage(url, { timeout = 8000 } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) throw new Error("bad url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/\.(internal|local|localhost)$|^localhost$/i.test(host)) throw new Error("bad host");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("bad host");
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "uk" }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) return fetchPage(new URL(r.headers.get("location"), u).href, { timeout });
  if (!r.ok) throw new Error(`${u.hostname}: ${r.status}`);
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) {
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { url: r.url || u.href, html: Buffer.concat(chunks).toString("utf8") };
}

const unent = (s) =>
  String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&#x27;/g, "'")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const textOf = (html) => unent(String(html || "").replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const metaOf = (html, prop) => unent(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)`, "i").exec(html)?.[1] || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i").exec(html)?.[1] || "").trim();
// A schema.org Event in the page's JSON-LD, if it has one.
function ldEvent(html) {
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j;
    try {
      j = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const all = [j, ...(Array.isArray(j) ? j : []), ...(j?.["@graph"] || [])].flat();
    const ev = all.find((x) => x && /Event$/.test([].concat(x["@type"] || [])[0] || ""));
    if (ev) return ev;
  }
  return null;
}

// What a page says about the event it shows: { title, sub, starts, ends, time, city, place }; empty strings
// where it says nothing we could read.
function readEvent(html, today = kyivDay()) {
  const ev = ldEvent(html);
  const h1 = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || "");
  const title = (ev?.name ? unent(ev.name) : "") || h1 || metaOf(html, "og:title") || textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
  const desc = metaOf(html, "og:description") || metaOf(html, "description");
  let when = null;
  if (ev?.startDate) {
    when = parseWhen(String(ev.startDate), today);
    const end = ev.endDate && parseWhen(String(ev.endDate), today);
    if (when && end && end.starts > when.starts) when.ends = end.starts;
  }
  if (!when) when = parseWhen(title, today) || parseWhen(desc, today) || parseWhen(textOf(html).slice(0, 3000), today);
  const loc = ev?.location ? [].concat(ev.location)[0] : null;
  const place = loc ? [loc.name, typeof loc.address === "string" ? loc.address : loc.address?.streetAddress].filter(Boolean).map(unent).join(", ") : "";
  const city = (loc && (findCity(typeof loc.address === "string" ? loc.address : loc.address?.addressLocality || "") || (/VirtualLocation/.test(loc["@type"] || "") ? "Онлайн" : ""))) || findCity(`${title} ${desc}`);
  return { title: cleanTitle(title), sub: desc.slice(0, 200), starts: when?.starts || "", ends: when?.ends || "", time: when?.time || "", city, place: place.slice(0, 120) };
}
// «Автограф-сесія Макса Кідрука 4 вересня 18:30 м.Рівне вул. Соборна 57 - Календар подій» → «Автограф-сесія Макса Кідрука».
function cleanTitle(t) {
  let s = String(t || "").replace(/\s*[-|–—]\s*(Календар подій|Книгарня «?Є»?|book-ye).*$/i, "").trim();
  const cut = new RegExp(`[\\s.,]+(\\d{1,2}(\\s*[-–]\\s*\\d{1,2})?\\s+(${MONTHS.join("|")})|м\\.\\s?[А-ЯІЇЄҐ]|\\d{1,2}\\.\\d{1,2}\\.20\\d\\d).*$`, "i").exec(s);
  if (cut && cut.index > 10) s = s.slice(0, cut.index);
  return s.replace(/[\s.,:;–—-]+$/, "").slice(0, 160);
}

function create(db, store, { notify = () => {} } = {}) {
  db.exec(SCHEMA);
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value || "";
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  const row = (r) => r && { ...r, books: JSON.parse(r.books || "[]"), authors: JSON.parse(r.authors || "[]"), hidden: !!r.hidden };

  // Upcoming events (not hidden), a minute's cache: the jobs process writes too.
  let cache = null;
  const upcoming = () => {
    if (cache && Date.now() - cache.at < 60000 && cache.day === kyivDay()) return cache.rows;
    const today = kyivDay();
    const rows = db
      .prepare("SELECT * FROM cal_events WHERE hidden = 0 AND (starts >= ? OR ends >= ?) ORDER BY starts, time, title LIMIT 500")
      .all(today, today)
      .map(row);
    cache = { at: Date.now(), day: today, rows };
    return rows;
  };
  const fresh = () => (cache = null);

  const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  // One event in, or updated in place (its hidden mark, who added it and when stay; `hidden: true` brings a new
  // one in hidden, to be checked first). → the id.
  function upsert(ev) {
    const id = ev.id || `${ev.source}:${ev.key}`;
    const title = clean(ev.title, 160);
    if (!title || !/^\d{4}-\d\d-\d\d$/.test(ev.starts || "")) return null;
    const city = clean(ev.city, 40) || findCity(`${ev.place || ""} ${title}`);
    const links = ev.books || ev.authors ? { books: ev.books || [], authors: ev.authors || [] } : linkText(store, `${title} ${ev.sub || ""}`);
    db.prepare(
      `INSERT INTO cal_events (id, source, url, title, sub, city, place, starts, ends, time, books, authors, by, added, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, sub = excluded.sub, city = excluded.city, place = excluded.place,
       starts = excluded.starts, ends = excluded.ends, time = excluded.time, books = excluded.books, authors = excluded.authors`,
    ).run(id, ev.source, clean(ev.url, 500), title, clean(ev.sub, 200), city, clean(ev.place, 120), ev.starts, /^\d{4}-\d\d-\d\d$/.test(ev.ends || "") && ev.ends > ev.starts ? ev.ends : "", /^\d\d:\d\d$/.test(ev.time || "") ? ev.time : "", JSON.stringify(links.books.slice(0, 6)), JSON.stringify(links.authors.slice(0, 6)), ev.by || "", new Date().toISOString(), ev.hidden ? 1 : 0);
    fresh();
    return id;
  }

  // «Додати подію» from a reader: { title, url, starts, time, city, place, sub } → { id } or { error }.
  function add(user, f) {
    const url = clean(f.url, 500);
    const title = clean(f.title, 160);
    if (title.length < 3) return { error: "Напишіть назву події." };
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return { error: "Додайте посилання на сторінку події." };
    if (!/^\d{4}-\d\d-\d\d$/.test(f.starts || "") || f.starts < kyivDay() || f.starts > addDays(kyivDay(), 400)) return { error: "Вкажіть дату події, не з минулого." };
    if (!clean(f.city, 40)) return { error: "Вкажіть місто або «Онлайн»." };
    const today = new Date().toISOString().slice(0, 10);
    if (!user.owner && db.prepare("SELECT count(*) n FROM cal_events WHERE by = ? AND added >= ?").get(user.id, today).n >= 5) return { error: "Сьогодні вже досить подій від вас. Завтра можна ще." };
    // The same link on the same day in another city is a tour's next stop, not the same event.
    const dup = db.prepare("SELECT id FROM cal_events WHERE url = ? AND starts = ? AND city = ?").get(url, f.starts, clean(f.city, 40));
    if (dup) return { id: dup.id };
    const id = upsert({ source: "reader", key: require("crypto").randomBytes(5).toString("hex"), url, title, sub: f.sub, city: f.city, place: f.place, starts: f.starts, ends: f.ends, time: f.time, by: user.id });
    if (!id) return { error: "Не вийшло зберегти. Перевірте дату." };
    return { id, event: row(db.prepare("SELECT * FROM cal_events WHERE id = ?").get(id)) };
  }

  const one = (id) => row(db.prepare("SELECT * FROM cal_events WHERE id = ?").get(id));
  // An event already kept that is the same one told elsewhere (Є's site and its Telegram channel): the same day
  // and city, and an author in common or half the title's words. → the row or null.
  const wordsOf = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\d]{4,}/gu) || []);
  function findSimilar({ starts, city = "", title = "", authors = null }) {
    const mine = wordsOf(title);
    const slugs = authors || linkText(store, title).authors;
    for (const r of db.prepare("SELECT * FROM cal_events WHERE starts = ?").all(starts).map(row)) {
      if (city && r.city && r.city !== city) continue;
      if (slugs.some((s) => r.authors.includes(s))) return r;
      const theirs = wordsOf(r.title);
      const common = [...mine].filter((w) => theirs.has(w)).length;
      if (common && common >= Math.min(mine.size, theirs.size) / 2) return r;
    }
    return null;
  }
  function hide(id) {
    db.prepare("UPDATE cal_events SET hidden = 1 WHERE id = ?").run(id);
    fresh();
  }
  function cleanup() {
    const before = addDays(kyivDay(), -KEEP_DAYS);
    const r = db.prepare("DELETE FROM cal_events WHERE max(starts, ends) < ?").run(before);
    fresh();
    return r.changes;
  }
  // web/seed/calendar.json at every start: [{ key, title, sub, url, city, place, starts, ends, time }].
  function seed() {
    let list = [];
    try {
      list = require("./seed/calendar.json");
    } catch {}
    let n = 0;
    for (const e of list) if (upsert({ ...e, source: "seed" })) n++;
    return n;
  }

  // The next events with this author or book (by an author of the book when none names it), soonest first.
  const forAuthor = (slug, n = 3) => upcoming().filter((e) => e.authors.includes(slug)).slice(0, n);
  function forBook(id, authorSlugs = [], n = 1) {
    const all = upcoming();
    const own = all.filter((e) => e.books.includes(id));
    return [...own, ...all.filter((e) => !own.includes(e) && e.authors.some((a) => authorSlugs.includes(a)))].slice(0, n);
  }

  // ---- Книгарня «Є» ----
  const YE = "https://book-ye.com.ua";
  const YE_CITY = { kyyiv: "Київ", lviv: "Львів", rivne: "Рівне", kharkiv: "Харків", odesa: "Одеса", dnipro: "Дніпро", ternopil: "Тернопіль", lutsk: "Луцьк", "ivano-frankivsk": "Івано-Франківськ", chernivtsi: "Чернівці", vinnytsia: "Вінниця", zhytomyr: "Житомир", uzhhorod: "Ужгород", poltava: "Полтава", cherkasy: "Черкаси", chernihiv: "Чернігів", khmelnytskyi: "Хмельницький", mukachevo: "Мукачево", "bila-tserkva": "Біла Церква" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let yeLast = null;
  // Reads the calendar: its main page and each city's, then the pages of events it has not seen (30 a run, one
  // every 1.5 s). `dry`: keeps nothing, returns what it would keep. Respects robots.txt.
  async function yeRun({ dry = false, max = 30 } = {}) {
    if (!dry && meta("calendar:ye") !== "on") return null;
    const out = { at: new Date().toISOString(), dry, cities: [], links: 0, read: 0, kept: [], skipped: [], errors: [] };
    try {
      const robots = await fetchPage(`${YE}/robots.txt`).then((r) => r.html).catch(() => "");
      const star = robots.split(/User-agent:/i).find((b) => /^\s*\*/.test(b)) || "";
      if (/Disallow:\s*\/calendar/i.test(star)) throw new Error("robots.txt disallows /calendar");
      const links = new Map(); // url -> { city, text }
      const collect = (html, base) => {
        for (const m of html.matchAll(/<a[^>]+href=["']([^"'#?]*\/calendar\/([a-z0-9-]+)\/([a-z0-9-]+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const url = new URL(m[1], base).href;
          if (!url.startsWith(YE)) continue;
          const text = textOf(m[4]);
          const had = links.get(url);
          if (!had || text.length > had.text.length) links.set(url, { city: YE_CITY[m[2]] || "", slug: m[2], text });
        }
      };
      const root = await fetchPage(`${YE}/calendar/`);
      collect(root.html, root.url);
      const cities = new Set([...root.html.matchAll(/href=["'][^"']*\/calendar\/([a-z0-9-]+)\/?["']/gi)].map((m) => m[1]).filter((s) => s !== "page"));
      out.cities = [...cities];
      for (const c of [...cities].slice(0, 25)) {
        await sleep(1500);
        try {
          const p = await fetchPage(`${YE}/calendar/${c}/`);
          collect(p.html, p.url);
        } catch (e) {
          out.errors.push(`${c}: ${e.message}`);
        }
      }
      out.links = links.size;
      const known = new Set(db.prepare("SELECT url FROM cal_events WHERE source = 'ye'").all().map((r) => r.url));
      const today = kyivDay();
      for (const [url, l] of links) {
        if (known.has(url)) continue;
        // The link's own text often carries the date and place: no page to read when it is in the past.
        const quick = parseWhen(l.text, today);
        if (quick && (quick.ends || quick.starts) < today) continue;
        if (out.read >= max) break;
        await sleep(1500);
        out.read++;
        try {
          const p = await fetchPage(url);
          const ev = readEvent(p.html, today);
          if (!ev.starts) ev.starts = quick?.starts || "";
          if (!ev.time && quick?.time) ev.time = quick.time;
          ev.city = l.city || ev.city || findCity(l.text);
          if (!ev.title || !ev.starts) {
            out.skipped.push({ url, why: "no title or date", title: ev.title || l.text });
            continue;
          }
          if ((ev.ends || ev.starts) < today) continue;
          const e = { source: "ye", key: url.replace(/^.*\/calendar\//, "").replace(/\/$/, ""), url, ...ev };
          if (dry) out.kept.push({ ...e, ...linkText(store, `${ev.title} ${ev.sub}`) });
          else if (upsert(e)) out.kept.push({ url, title: ev.title, starts: ev.starts });
        } catch (e) {
          out.errors.push(`${url}: ${e.message}`);
        }
      }
    } catch (e) {
      out.errors.push(e.message);
    }
    if (!dry) setMeta("calendar:ye:last", JSON.stringify({ at: out.at, links: out.links, read: out.read, kept: out.kept.length, errors: out.errors.slice(0, 5) }));
    yeLast = out;
    if (dry) return out;
    return { kept: out.kept.length, read: out.read, errors: out.errors.length ? out.errors.slice(0, 3) : undefined };
  }

  // «Заповнити з посилання» on /calendar/add: what the page says, never kept.
  async function peek(url) {
    const p = await fetchPage(url);
    return readEvent(p.html);
  }

  const cities = () => {
    const n = new Map();
    for (const e of upcoming()) if (e.city) n.set(e.city, (n.get(e.city) || 0) + 1);
    return [...n].sort((a, b) => (a[0] === "Онлайн") - (b[0] === "Онлайн") || b[1] - a[1] || a[0].localeCompare(b[0], "uk")).map(([c]) => c);
  };

  return { upsert, add, one, findSimilar, hide, cleanup, seed, upcoming, forAuthor, forBook, cities, yeRun, yeLast: () => yeLast, peek, fresh, meta, setMeta };
}

// «Четвер, 19 листопада» and, within a week, «завтра» / «через 3 дні».
function dayName(day, today = kyivDay()) {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function dayAside(day, today = kyivDay()) {
  const n = Math.round((Date.parse(day) - Date.parse(today)) / 86400000);
  if (n === 0) return "сьогодні";
  if (n === 1) return "завтра";
  if (n > 1 && n < 7) return `через ${n} ${n < 5 ? "дні" : "днів"}`;
  return "";
}
// «19–20 листопада», «30 листопада – 2 грудня».
function span(e) {
  const a = new Date(`${e.starts}T12:00:00Z`);
  if (!e.ends) return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`;
  const b = new Date(`${e.ends}T12:00:00Z`);
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}` : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}
// One event held in several cities or on several days (a publisher's tour, Max 2026-11-15: «щоб в стрічці не
// повторювалось тричі»): the same title once its city is cut off («… в Ужгороді», «… у Львові») and the same link
// (or the same post). → the events in order, each tour as its first stop with `stops` (all of them, itself too)
// and the title without the city.
const CITY_TAIL = /(?:\s+(?:в|у|ві)\s+(?:м\.\s*)?|\s*[,(–—-]\s*)([^\s«»,()]+(?:[\s-][^\s«»,()]+)?)\)?\s*$/;
function tourTitle(e) {
  const m = (e.title || "").match(CITY_TAIL);
  return m && e.city && e.city !== "Онлайн" && findCity(m[1]) === e.city ? e.title.slice(0, m.index).trim() : e.title;
}
function tours(events) {
  const groups = new Map();
  const out = [];
  for (const e of events) {
    const title = tourTitle(e);
    const key = `${title.toLowerCase()}|${e.url || e.id.replace(/-\d+$/, "")}`;
    const g = groups.get(key);
    if (g) {
      g.stops.push(e);
      continue;
    }
    const first = { ...e, stops: [e], tourTitle: title };
    groups.set(key, first);
    out.push(first);
  }
  return out.map((g) => (g.stops.length > 1 ? { ...g, title: g.tourTitle } : { ...g, stops: null }));
}

const SHORT_DAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const shortWhen = (e) => `${SHORT_DAYS[new Date(`${e.starts}T12:00:00Z`).getUTCDay()]}, ${span(e)}`;

module.exports = { create, tours, parseWhen, linkText, readEvent, cleanTitle, findCity, kyivDay, addDays, dayName, dayAside, span, shortWhen, MONTHS };
