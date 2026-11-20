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
// An event about an author or book in the catalog stays a year after it ended: the author's page lists the past ones
// (Max 2026-11-16). A few thousand small rows a year.
const KEEP_LINKED_DAYS = 365;
const CALBOOKS_DAY = 30; // new catalog books from events a day (fillBooks)
const { norm, sameAuthor, isRussian, editDistance } = require("./store");
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
// Only Ukraine and online for now (Max 2026-11-15, a library in Galway): the collectors' Haiku says `abroad`, and
// these cities are kept out whatever it says.
const ABROAD = /^([ґг][оа]лвей|galway|дублін|корк|лондон|единбург|прага|брно|варшава|краків|вроцлав|гданськ|познань|люблін|лодзь|катовіце|ряшів|жешув|перемишль|берлін|мюнхен|гамбург|франкфурт|кельн|лейпциг|дрезден|відень|цюрих|женева|берн|базель|париж|ліон|брюссель|амстердам|роттердам|гаага|копенгаген|стокгольм|осло|гельсінкі|таллінн|тарту|рига|вільнюс|каунас|кишинів|бухарест|будапешт|братислава|кошице|любляна|загреб|рим|мілан|неаполь|мадрид|барселона|валенсія|лісабон|порту|афіни|тбілісі|батумі|анкара|стамбул|нью-йорк|чикаго|торонто|ванкувер|монреаль|вашингтон|лос-анджелес|сідней|мельбурн)$/i;
// An event about genre romance by its words: its books are not added to the catalog (see wanted()).
const ROMANCE_EVENT = /ромком|романтас|ромфант|любовн\S* роман|dark romance|дарк[- ]?роман|(?<!\p{L})троп(и|ів)(?!\p{L})|закохуємо/iu;
const abroad = (city) => ABROAD.test(String(city || "").trim());
// A book's presentation (Max 2026-11-20: «спам презентацій», 80 of ~300 upcoming, mostly libraries' local books and
// one author's 30-city tour): out of the calendar's lists, the homepage and subscriptions; still on the author's and
// the book's pages, under «Мої автори», in a search and in their own list (/calendar?pres=1). A festival stays.
const PRESENTATION = /презентаці|презентуєм|презентує/i;
const presentation = (e) => e.kind !== "festival" && PRESENTATION.test(e.title || "");
// One apostrophe (Кам'янське and Кам’янське were two cities and three rows of one event, 2026-11-20).
const apos = (s) => String(s ?? "").replace(/['ʼ‘`´]/g, "’");
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
// A catalog book for a name in an event, never a Russian edition (the Ukrainian «Гаррі Поттер і Орден Фенікса», not
// «Гарри Поттер и Орден Феникса»).
// A title a letter or two apart («Адді Ларю» for «Адді Лярю», «Ґетсбі» for «Гетсбі») or one of several editions
// («Гаррі Поттер і орден Фенікса» with no author) is the search's best book whose title is that close: by the
// author named, or, with none, the same title of 6+ letters.
function findBook(store, q) {
  const russian = (id) => isRussian(store.book?.(id, { edited: false, borrow: false }) || {});
  const id = store.findWork({ ...q, not: russian });
  if (id || !store.search) return id;
  const key = (t) => norm(String(t || "").split(/[:(]|\.\s/)[0]);
  const want = key(q.title);
  if (want.length < (q.author ? 4 : 6)) return null;
  for (const h of store.search(want, { limit: 5 }).slice(0, 5)) {
    const b = h.book;
    // As the page shows it: a work kept under a Russian edition's id shows its Ukrainian one («Гаррі Поттер і Орден Фенікса»).
    if (!b?.id || isRussian(store.book?.(b.id) || b)) continue;
    const d = editDistance(want, key(b.title), 2);
    if (q.author ? norm(q.author) && b.author && sameAuthor(q.author, b.author) && d <= (want.length >= 10 ? 2 : want.length >= 6 ? 1 : 0) : d === 0) return store.canonical?.(b.id) || b.id;
  }
  return null;
}

// Titles in an event's words: in «», "", “” or „“ (some sites write "…"); a quote opens after a space and closes before
// a space or a stop, so «Книжковий клуб "Чита"Є"мо"» stays one name. `book`: the words before it say it is a book
// («книги», «роман Ірини …», «за книгою»); a name right after «клуб», «книгарня» and the like is no book (`place`).
const BOOK_WORD = /^(книг[аиуі]?|книгою|книзі|книжк[аиуі]|книжкою|книжці|книжок|роман[аиуі]?|романом|збірк[аиуі]|збірок|повіст[іь]|повістю|серії|серію|серія|циклу|частин[аиуі]?|твор[уиі]?|новинк[аиуі]|поем[аиуі]|казк[аиуі]|бестселер[аиуі]?|п.єс[аиуі]|трилогі[їяю]|саг[аиуі]|том[уі]?|томів)$/u;
const NOT_BOOK = /^(клуб|спільнот|книгарн|бібліотек|кав.?ярн|фестивал|проєкт|проект|центр|медіатек|видавництв|магазин|простір|го|галере|музе|кінотеатр|театр|ресторан|канал|школ|курс|подкаст|вечір|зустріч|виставк|акці|марафон|челендж|гр[аиу])/u;
function quotes(text) {
  const t = String(text || "");
  const out = [];
  for (const m of t.matchAll(/(?<=^|[\s(:—–-])["“„«](.{2,120}?)["”“»](?=$|[\s.,:;!?)…—–-])/gu)) {
    let title = m[1].trim();
    if (title.includes("«")) title = title.slice(title.lastIndexOf("«") + 1).replace(/»$/, ""); // «Розмова про «Доцю»»
    if (title.length < 2 || out.some((x) => x.title === title)) continue;
    const before = (t.slice(Math.max(0, m.index - 60), m.index).toLowerCase().match(/[\p{L}’'ʼ-]+/gu) || []).slice(-4);
    const place = NOT_BOOK.test(before[before.length - 1] || "");
    out.push({ title, place, book: !place && before.slice(-3).some((w) => BOOK_WORD.test(w)) });
  }
  return out;
}

function linkText(store, text) {
  const out = { authors: [], books: [] };
  const t = String(text || "");
  if (!t || !store?.authors) return out;
  const raw = t.replace(/[’'ʼ`]/g, "").match(/[\p{L}-]+/gu) || [];
  const words = raw.map((w) => w.toLowerCase());
  // A name in any case («Сари Маас», «Маас Сара»): its two words side by side (one word between for «Дж.»), each
  // word starting with the name's stem. Apart they meant nothing: «Олександрою … у книгарні» was «Олександр Книга».
  const stem = (w) => {
    const s = w.length >= 4 ? w.replace(/[аяоеєіиїйьую]$/, "") : w;
    return s.length >= 3 ? s : w;
  };
  // «Петрова-Домонтовича»: a second surname after a hyphen starts with a capital («боді-горор» is no Гор).
  const has = (i, s) => words[i].startsWith(s) || (words[i].includes(`-${s}`) && /-\p{Lu}/u.test(raw[i]));
  const at = (i, s) => i < words.length && has(i, s);
  const side = (fs, ls) => words.some((w, i) => (has(i, fs) && (at(i + 1, ls) || at(i + 2, ls))) || (has(i, ls) && at(i + 1, fs)));
  for (const a of store.authors.list) {
    const name = (a.uk || a.name || "").toLowerCase().replace(/[’'ʼ`]/g, "");
    if (!/[а-яіїєґ]/.test(name)) continue;
    const parts = name.split(/\s+/).filter((p) => p.length > 1 && !p.endsWith("."));
    if (parts.length < 2) continue;
    const ls = stem(parts[parts.length - 1]);
    if (ls.length >= 3 && side(parts[0].slice(0, 3), ls)) out.authors.push(a.slug);
  }
  const names = out.authors.map((s) => store.authors.bySlug.get(s)?.name).filter(Boolean);
  for (const { title, place } of quotes(t)) {
    if (place) continue;
    const id = (names.length ? names.map((n) => findBook(store, { title, author: n })).find(Boolean) : null) || findBook(store, { title });
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
async function fetchPage(url, { timeout = 8000, accept = "text/html", max = 1024 * 1024 } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) throw new Error("bad url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/\.(internal|local|localhost)$|^localhost$/i.test(host)) throw new Error("bad host");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("bad host");
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "uk" }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) return fetchPage(new URL(r.headers.get("location"), u).href, { timeout, accept, max });
  if (!r.ok) throw new Error(`${u.hostname}: ${r.status}`);
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
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

// What sort of event, for the chips on /calendar (Max 2026-11-15 chose these five; the page thread draws them).
const KINDS = [
  { key: "club", label: "Книжкові клуби" },
  { key: "author", label: "Зустрічі з авторами" },
  { key: "lecture", label: "Лекції й курси" },
  { key: "festival", label: "Фестивалі та ярмарки" },
  { key: "kids", label: "Для дітей" },
];

// ---- An organizer's own calendar (iCalendar, Max 2026-11-15: «імпорт календарів організаторів») ----
// A Google Calendar link of any shape (embed ?src=, ?cid=, the .ics itself) or webcal:// → the address of its .ics.
function icsAddress(raw) {
  let s = String(raw || "").trim().replace(/^webcal:\/\//i, "https://");
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  if (/(^|\.)calendar\.google\.com$/i.test(u.hostname) && !/\/ical\//.test(u.pathname)) {
    let id = u.searchParams.get("src") || "";
    const cid = u.searchParams.get("cid");
    if (!id && cid) {
      try {
        id = /@|\./.test(cid) ? cid : Buffer.from(cid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {}
    }
    return id ? `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics` : "";
  }
  return u.href;
}
// iCalendar text → [{ uid, title, sub, place, url, starts, ends, time, status }] in Kyiv days and time. Unfolds lines;
// a time in UTC (…Z) turns into Kyiv's, a TZID one is taken as it is, a whole day (VALUE=DATE) has no time; an
// all-day DTEND is the day after. A repeating event (RRULE) gives its first meeting only.
function parseIcs(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const un = (v) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
  const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const when = (params, v) => {
    const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(v.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, , z] = m;
    if (!h || /VALUE=DATE(?!-)/i.test(params)) return { day: `${y}-${mo}-${d}`, time: "", allDay: true };
    if (z) {
      const t = Date.UTC(+y, +mo - 1, +d, +h, +mi);
      return { day: kyivDay(t), time: clock.format(new Date(t)) };
    }
    return { day: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  };
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) ev = {};
    else if (/^END:VEVENT/i.test(line)) {
      if (ev?.start) {
        let ends = ev.end?.day || "";
        if (ev.end?.allDay && ends) ends = addDays(ends, -1);
        out.push({ uid: ev.uid || `${ev.start.day}-${ev.title || ""}`, title: ev.title || "", sub: ev.sub || "", place: ev.place || "", url: ev.url || "", starts: ev.start.day, ends: ends > ev.start.day ? ends : "", time: ev.start.time, status: ev.status || "" });
      }
      ev = null;
    } else if (ev) {
      const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (!m) continue;
      const [, name, params, value] = m;
      const k = name.toUpperCase();
      if (k === "UID") ev.uid = value.trim();
      else if (k === "SUMMARY") ev.title = un(value);
      else if (k === "DESCRIPTION") ev.sub = un(value);
      else if (k === "LOCATION") ev.place = un(value);
      else if (k === "URL") ev.url = value.trim();
      else if (k === "STATUS") ev.status = value.trim().toUpperCase();
      else if (k === "DTSTART") ev.start = when(params, value);
      else if (k === "DTEND") ev.end = when(params, value);
    }
  }
  return out;
}

function create(db, store, { notify = () => {}, bookua = null, search = null, made = () => {} } = {}) {
  db.exec(SCHEMA);
  // Books an event names that the catalog did not have yet: [{ title, author }] (fillBooks looks for them outside).
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN want TEXT NOT NULL DEFAULT '[]'");
  } catch {}
  // What sort of event (KINDS' keys, '' = not known yet): the collectors' Haiku says it, tgFeed.classify the rest.
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
  } catch {}
  // The organizer's page Max gave on /admin/events: wins over `url`, and no collector writes it.
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN link TEXT NOT NULL DEFAULT ''");
  } catch {}
  // A guest's event (no account, Max 2026-11-16): `review` 1 = waits hidden until Max shows it on /admin/events;
  // `contact` = the e-mail a guest may leave, never shown on the site.
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN review INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN contact TEXT NOT NULL DEFAULT ''");
  } catch {}
  // Cancelled or moved by a later post (tgfeed): JSON { how, post, at }, '' = not.
  try {
    db.exec("ALTER TABLE cal_events ADD COLUMN cancelled TEXT NOT NULL DEFAULT ''");
  } catch {}
  // Events abroad that came in before the rule are hidden (Max 2026-11-15: Ukraine and online only).
  try {
    const hideRow = db.prepare("UPDATE cal_events SET hidden = 1 WHERE id = ?");
    for (const r of db.prepare("SELECT id, city FROM cal_events WHERE hidden = 0 AND city != ''").all()) if (abroad(r.city)) hideRow.run(r.id);
  } catch {}
  // Cities written with another apostrophe before the rule: one spelling.
  try {
    db.prepare("UPDATE cal_events SET city = replace(replace(replace(city, '''', '’'), 'ʼ', '’'), '‘', '’') WHERE city GLOB '*[''ʼ‘]*'").run();
  } catch {}
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value || "";
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  // A guest's e-mail stays out of every row; only pending() hands it on, for Max.
  const row = (r) => {
    if (!r) return r;
    const { contact, ...e } = r;
    return { ...e, books: JSON.parse(r.books || "[]"), authors: JSON.parse(r.authors || "[]"), hidden: !!r.hidden };
  };

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
    const city = apos(clean(ev.city, 40) || findCity(`${ev.place || ""} ${title}`));
    if (abroad(city)) ev = { ...ev, hidden: true };
    const links = ev.books || ev.authors ? { books: ev.books || [], authors: ev.authors || [] } : linkText(store, `${title} ${ev.sub || ""}`);
    const want = wanted(ev, title, links);
    for (const id of links.books) for (const a of store.authors?.list || []) if (a.ids.includes(id) && !links.authors.includes(a.slug)) links.authors.push(a.slug);
    const kind = KINDS.some((k) => k.key === ev.kind) ? ev.kind : "";
    db.prepare(
      `INSERT INTO cal_events (id, source, url, title, sub, city, place, starts, ends, time, books, authors, by, added, hidden, want, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, sub = excluded.sub, city = excluded.city, place = excluded.place,
       starts = excluded.starts, ends = excluded.ends, time = excluded.time, books = excluded.books, authors = excluded.authors, want = excluded.want,
       kind = CASE WHEN excluded.kind != '' THEN excluded.kind ELSE cal_events.kind END`,
    ).run(id, ev.source, clean(ev.url, 500), title, clean(ev.sub, 200), city, clean(ev.place, 120), ev.starts, /^\d{4}-\d\d-\d\d$/.test(ev.ends || "") && ev.ends > ev.starts ? ev.ends : "", /^\d\d:\d\d$/.test(ev.time || "") ? ev.time : "", JSON.stringify(links.books.slice(0, 6)), JSON.stringify(links.authors.slice(0, 6)), ev.by || "", new Date().toISOString(), ev.hidden ? 1 : 0, JSON.stringify(want), kind);
    fresh();
    return id;
  }
  // Kinds for events that have none: { id: key } (tgFeed.classify).
  function setKinds(kinds) {
    const up = db.prepare("UPDATE cal_events SET kind = ? WHERE id = ? AND kind = ''");
    let n = 0;
    for (const [id, k] of Object.entries(kinds)) if (KINDS.some((x) => x.key === k)) n += up.run(k, id).changes;
    if (n) fresh();
    return n;
  }

  // The books an event names that the catalog lacks, with their author: the ones Haiku named (`ev.named`, the
  // Telegram and Chytomo collectors), and titles in «» when the text names an author we know. The ones found join
  // `links.books`. → [{ title, author }] to look for outside.
  function wanted(ev, title, links) {
    const known = links.authors.map((s) => store.authors?.bySlug.get(s)?.name).filter(Boolean);
    const named = (Array.isArray(ev.named) ? ev.named : []).map((b) => ({ title: clean(b?.title, 120).replace(/^«|»$/g, ""), author: clean(b?.author, 80), ...(b?.romance ? { romance: true } : {}) }));
    // Romance is never added to the catalog from an event (Max 2026-11-17: «Це якийсь ромком? Давай таке не додавати»):
    // Haiku's `romance`, or an event about it by its words (a title in quotes has no Haiku answer).
    const romantic = ROMANCE_EVENT.test(`${title} ${ev.sub || ""}`);
    // A title the words call a book («Презентація книги "Північ, якої не існує"»), by the one author named, or with
    // none (then fillBooks takes only book.ua's Ukrainian edition of that very title).
    for (const q of quotes(`${title} ${ev.sub || ""}`)) if (q.book || (known.length === 1 && !q.place)) named.push({ title: q.title, author: known.length === 1 ? known[0] : "", ...(romantic ? { romance: true } : {}) });
    const out = [];
    for (const b of named) {
      if (b.title.length < 2 || (!b.author && norm(b.title).length < 6) || out.some((x) => norm(x.title) === norm(b.title))) continue;
      const id = store.findWork ? findBook(store, { title: b.title, author: b.author }) : null;
      if (id) {
        if (!links.books.includes(id)) links.books.push(id);
      } else out.push(b);
    }
    return out.slice(0, 4);
  }

  // The books upcoming events name that the catalog lacks (Max 2026-11-15: «додавати їх в каталог, якщо їх
  // немає»): a Ukrainian edition on book.ua, else in Google Books / Open Library (as /ask does), 30 new books a day,
  // never a Russian one. Each name is looked for once. dry: what it would add.
  async function fillBooks({ dry = false } = {}) {
    if (!bookua && !search) return { made: [], missed: [] };
    const { confirm } = require("./readerbooks");
    const head = (t) => norm(String(t || "").split(/[:(]|\.\s|\s[-–—]\s/)[0]);
    const day = kyivDay();
    let count = { day, n: 0 };
    try {
      const c = JSON.parse(meta("calbooks:count") || "null");
      if (c?.day === day) count = c;
    } catch {}
    const out = { made: [], found: [], missed: [] };
    // Once: the events from before books were looked for get their «» titles by a known author.
    if (!dry && !meta("calbooks:rewant")) {
      for (const e of db.prepare("SELECT * FROM cal_events WHERE want = '[]' AND (starts >= ? OR ends >= ?)").all(day, day).map(row)) {
        const links = { books: [...e.books], authors: e.authors };
        const want = wanted(e, e.title, links);
        if (want.length || links.books.length > e.books.length) db.prepare("UPDATE cal_events SET books = ?, want = ? WHERE id = ?").run(JSON.stringify(links.books.slice(0, 6)), JSON.stringify(want), e.id);
      }
      setMeta("calbooks:rewant", new Date().toISOString());
    }
    // Once: the collectors' events get their names again by the stricter linkText (2026-11-15, «Олександр Книга»),
    // and lose a Russian edition they linked.
    if (!dry && !meta("calendar:relink2")) {
      for (const e of db.prepare("SELECT * FROM cal_events WHERE source IN ('tg', 'chytomo', 'ye', 'eventmate') AND (starts >= ? OR ends >= ?)").all(day, day).map(row)) {
        const links = linkText(store, `${e.title} ${e.sub || ""}`);
        for (const id of e.books) if (!links.books.includes(id) && !isRussian(store.book?.(id, { edited: false, borrow: false }) || {})) links.books.push(id);
        for (const id of links.books) for (const a of store.authors.list) if (a.ids.includes(id) && !links.authors.includes(a.slug)) links.authors.push(a.slug);
        const want = wanted({ ...e, named: JSON.parse(e.want || "[]") }, e.title, links);
        db.prepare("UPDATE cal_events SET books = ?, authors = ?, want = ? WHERE id = ?").run(JSON.stringify(links.books.slice(0, 6)), JSON.stringify(links.authors.slice(0, 6)), JSON.stringify(want), e.id);
      }
      setMeta("calendar:relink2", new Date().toISOString());
      fresh();
    }
    // Once (2026-11-16, Max: «Події не завжди знаходять книги»): titles in "" and “”, a letter apart or with no author;
    // relink4: authors found again («боді-горор» had named Розі Гор).
    if (!dry && !meta("calendar:relink4")) {
      for (const e of db.prepare("SELECT * FROM cal_events WHERE (starts >= ? OR ends >= ?)").all(day, day).map(row)) {
        const links = linkText(store, `${e.title} ${e.sub || ""}`);
        for (const id of e.books) if (!links.books.includes(id)) links.books.push(id);
        const want = wanted({ ...e, named: JSON.parse(e.want || "[]") }, e.title, links);
        for (const id of links.books) for (const a of store.authors.list) if (a.ids.includes(id) && !links.authors.includes(a.slug)) links.authors.push(a.slug);
        db.prepare("UPDATE cal_events SET books = ?, authors = ?, want = ? WHERE id = ?").run(JSON.stringify(links.books.slice(0, 6)), JSON.stringify(links.authors.slice(0, 6)), JSON.stringify(want), e.id);
      }
      setMeta("calendar:relink4", new Date().toISOString());
      fresh();
    }
    // Books the catalog no longer has (Max took out three romances, 2026-11-17) leave the events that linked them.
    if (!dry) {
      const { DROPPED } = require("./store");
      for (const e of db.prepare("SELECT id, books FROM cal_events WHERE books != '[]'").all()) {
        const ids = JSON.parse(e.books || "[]");
        const kept = ids.filter((id) => !DROPPED.has(id));
        if (kept.length < ids.length) db.prepare("UPDATE cal_events SET books = ? WHERE id = ?").run(JSON.stringify(kept), e.id);
      }
    }
    const rows = db.prepare("SELECT * FROM cal_events WHERE want != '[]' AND (starts >= ? OR ends >= ?)").all(day, day).map(row);
    for (const e of rows) {
      const left = [];
      const books = [...e.books];
      for (const w of JSON.parse(e.want || "[]")) {
        let id = findBook(store, { title: w.title, author: w.author });
        // Romance: linked when the catalog has it, never added (dropped from `want`).
        if (!id && w.romance) continue;
        if (!id && w.tried === day) {
          left.push(w);
          continue;
        }
        if (!id) {
          if (count.n >= CALBOOKS_DAY) {
            left.push(w);
            continue;
          }
          let book = null;
          let from = "";
          const hits = bookua ? await bookua(w.title.split(/[:(]|\.\s/)[0]).catch(() => []) : [];
          const hit = hits.find((h) => head(h.title) === head(w.title) && sameAuthor(w.author, h.author) && /українськ/i.test(h.language) && h.format !== "Аудіо");
          if (hit) (book = { title: hit.title.replace(/^«([^»]+)»/, "$1"), author: hit.author, cover: /^https:\/\/i\.book\.ua\//.test(hit.cover) ? hit.cover : "", links: [{ label: "book.ua", url: hit.url }], language: "українська", ...(hit.isbn ? { isbns: [hit.isbn] } : {}), ...(hit.year ? { published: hit.year } : {}) }), (from = "book.ua");
          if (!book && search && w.author) {
            const g = await confirm({ title: w.title, author: w.author, language: "українська" }, search).catch(() => null);
            if (g && /[а-яіїєґ]/i.test(g.title)) {
              const gl = /^https:\/\/(books\.google\.[a-z.]+|play\.google\.com)\//.test(g.google || "") ? [{ label: "Google Books", url: g.google }] : [];
              const cover = /^https:\/\/(covers\.openlibrary\.org|books\.google\.[a-z.]+|books\.googleusercontent\.com)\//.test(g.cover || "") ? g.cover : "";
              (book = { title: w.title.split(": ")[0], author: w.author || g.author, cover, links: gl, language: "українська", ...(g.isbns?.length ? { isbns: g.isbns.slice(0, 20) } : {}), ...(Number(g.published) ? { published: Number(g.published) } : {}) }), (from = g.from || "Google Books");
            }
          }
          if (!book || isRussian(book)) {
            // Asked again each day until the event is over: a fresh translation reaches book.ua later («Найкраще – це
            // очі», Max 2026-11-16).
            left.push({ ...w, tried: day });
            out.missed.push({ ...w, event: e.id });
            continue;
          }
          id = store.findWork({ title: book.title, author: book.author, isbns: book.isbns || [] });
          if (!id) {
            if (dry) {
              out.made.push({ ...book, from, event: e.id });
              continue;
            }
            id = store.addBook({ ...book, source: "calendar" }).id;
            count.n++;
            setMeta("calbooks:count", JSON.stringify(count));
            out.made.push({ id, title: book.title, author: book.author, from, event: e.id, eventTitle: e.title });
          }
        }
        if (id && !books.includes(id)) books.push(id), out.found.push({ id, event: e.id });
      }
      if (!dry) {
        const authors = [...e.authors];
        for (const id of books) for (const a of store.authors?.list || []) if (a.ids.includes(id) && !authors.includes(a.slug)) authors.push(a.slug);
        db.prepare("UPDATE cal_events SET books = ?, authors = ?, want = ? WHERE id = ?").run(JSON.stringify(books.slice(0, 6)), JSON.stringify(authors.slice(0, 6)), JSON.stringify(left), e.id);
      }
    }
    if (!dry) fresh();
    if (!dry && out.made.length) made(out.made);
    return out;
  }

  // ---- Chytomo's calendar (chytomo.com/kalendar/, Max 2026-11-15) ----
  // Its cards «зустрічі та враження» and «освітні» (not contests, grants, jobs): each article not seen yet goes to
  // `extract(text, url)` (the Telegram collector's Haiku), its events in as source `chytomo`, one a day at most
  // 10 articles; the same event told elsewhere (findSimilar) is left out. dry: nothing kept.
  const CHYTOMO = "https://chytomo.com";
  const articleForm = (body) => {
    const forms = [...new Set([...String(body || "").matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => unent(m[1])).filter((u) => linkKind(u) === "form"))];
    return forms.length === 1 ? forms[0] : "";
  };
  async function chytomoRun({ extract, dry = false, max = 10 } = {}) {
    const out = { at: new Date().toISOString(), dry, cards: 0, read: 0, made: [], dupes: [], skipped: [], errors: [] };
    if (!extract) return out;
    // Once: upcoming events that link to their article get its one sign-up form, if it has one.
    if (!dry && !meta("chytomo:forms")) {
      const today = kyivDay();
      const rows = db.prepare("SELECT id, url FROM cal_events WHERE source = 'chytomo' AND url LIKE 'https://chytomo.com/%' AND (starts >= ? OR ends >= ?)").all(today, today);
      const pages = new Map();
      for (const r of rows) {
        try {
          if (!pages.has(r.url)) pages.set(r.url, articleForm((await fetchPage(r.url)).html));
        } catch {
          pages.set(r.url, "");
        }
        if (pages.get(r.url)) db.prepare("UPDATE cal_events SET url = ? WHERE id = ?").run(pages.get(r.url), r.id);
      }
      setMeta("chytomo:forms", new Date().toISOString());
      fresh();
    }
    const seen = new Set(JSON.parse(meta("chytomo:seen") || "[]"));
    const list = await fetchPage(`${CHYTOMO}/kalendar/`);
    const cards = [...list.html.matchAll(/<a class="event__link" href="([^"]+)"[^>]*title="([^"]*)">([\s\S]*?)<\/a>/g)].map((m) => ({ url: m[1], title: unent(m[2]), kind: (/liner--dark">([^<]*)</.exec(m[3])?.[1] || "").trim() }));
    out.cards = cards.length;
    for (const c of cards) {
      if (!c.url.startsWith(`${CHYTOMO}/`) || !/зустрічі|освітні/i.test(c.kind)) {
        out.skipped.push(`${c.title} (${c.kind || "?"})`);
        continue;
      }
      const slug = c.url.replace(/\/+$/, "").split("/").pop();
      if (seen.has(slug) || out.read >= max) continue;
      await sleep(1500);
      let page;
      try {
        page = await fetchPage(c.url);
      } catch (e) {
        out.errors.push(`${slug}: ${e.message}`);
        continue;
      }
      out.read++;
      const body = /<div class="text"[\s\S]*?(?=<div class="(?:social|donate)|<footer)/.exec(page.html)?.[0] || page.html;
      let found;
      try {
        found = await extract(`${c.title}\n\n${textOf(body).slice(0, 6000)}`, c.url);
      } catch (e) {
        out.errors.push(`${slug}: ${e.message}`);
        continue;
      }
      // The article's one sign-up form is the event's link, not the article (Max 2026-11-16: «ПалімФест»'s talk led
      // to Chytomo's piece on the whole festival, under «Сайт організатора»).
      const form = articleForm(body);
      found.forEach((e, i) => {
        const ev = { source: "chytomo", key: `${slug}${i ? `-${i}` : ""}`, ...e, ...(form ? { url: form } : {}) };
        const twin = findSimilar({ starts: e.starts, city: e.city, title: e.title, time: e.time });
        if (twin && twin.id !== `chytomo:${ev.key}`) return out.dupes.push({ title: e.title, twin: twin.id });
        if (!dry) upsert(ev);
        out.made.push({ title: e.title, starts: e.starts, city: e.city, named: e.named });
      });
      seen.add(slug);
    }
    if (!dry) setMeta("chytomo:seen", JSON.stringify([...seen].slice(-300)));
    if (!dry) setMeta("chytomo:last", JSON.stringify({ ...out, made: out.made.length, skipped: out.skipped.length }));
    return out;
  }

  // ---- Eventmate (eventmate.app, Max 2026-11-15: «не вистачає sources») ----
  // An events app whose pages are open (robots: all; «Місто читає», online clubs). Its sitemaps list every event in
  // six languages; the Ukrainian address whose name looks bookish (`EM_BOOKISH`, a transliteration) and was not seen
  // yet is read once (≤250 pages a run, 1 s apart). Its date is in the page (`startDate`): a past one costs nothing,
  // an upcoming one goes to `extract` (the Telegram collector's Haiku, ≤ max a run), source `eventmate`, linked to its
  // page there; the same event told elsewhere (findSimilar) is left out. dry: nothing kept.
  const EVENTMATE = "https://eventmate.app";
  const EM_BOOKISH = /knyh|knyz|knig|kniz|book|klub|club|cita|chyt|liter|poez|poet|avtor|prezent|roman|vidavn|manga|manh/i;
  async function eventmateRun({ extract, dry = false, max = 20, pages = 250 } = {}) {
    const out = { at: new Date().toISOString(), dry, candidates: 0, read: 0, past: 0, asked: 0, made: [], dupes: [], errors: [] };
    if (!extract) return out;
    const today = kyivDay();
    let seen = {};
    try {
      seen = JSON.parse(meta("eventmate:seen") || "{}");
    } catch {}
    // Once (2026-11-15): read again, so the events first seen as Telegram twins get these pages as links.
    if (!dry && !meta("eventmate:relink")) seen = {};
    let relinked = 0;
    const index = await fetchPage(`${EVENTMATE}/sitemap.xml`, { accept: "application/xml, text/xml" });
    const maps = [...index.html.matchAll(/<loc>(https:\/\/eventmate\.app\/sitemap\/events\/\d+\.xml)<\/loc>/g)].map((m) => m[1]);
    const slugs = [];
    for (const m of maps) {
      try {
        const x = await fetchPage(m, { timeout: 15000, accept: "application/xml, text/xml", max: 4 * 1024 * 1024 });
        for (const [, slug] of x.html.matchAll(/<loc>https:\/\/eventmate\.app\/events\/share\/([a-z0-9-]+)\?locale=uk<\/loc>/g)) if (EM_BOOKISH.test(slug) && !seen[slug]) slugs.push(slug);
      } catch (e) {
        out.errors.push(`${m}: ${e.message}`);
      }
    }
    out.candidates = slugs.length;
    // Newest last in the sitemaps: read from the end.
    for (const slug of slugs.reverse()) {
      if (out.read >= pages || out.asked >= max) break;
      await sleep(1000);
      const url = `${EVENTMATE}/events/share/${slug}`;
      let page;
      try {
        page = await fetchPage(`${url}?locale=uk`);
      } catch (e) {
        out.errors.push(`${slug}: ${e.message}`);
        continue;
      }
      out.read++;
      seen[slug] = today;
      const html = page.html;
      const starts = /startDate="(\d{4}-\d\d-\d\d)"/.exec(html)?.[1] || "";
      const ends = /endDate="(\d{4}-\d\d-\d\d)"/.exec(html)?.[1] || "";
      if (!starts || (ends > starts ? ends : starts) < today) {
        out.past++;
        continue;
      }
      const time = /startTime="(\d\d:\d\d)"/.exec(html)?.[1] || "";
      const where = unent(/\blocation="([^"]*)"/.exec(html)?.[1] || "");
      const title = metaOf(html, "og:title");
      const text = metaOf(html, "og:description") || metaOf(html, "description");
      out.asked++;
      let found;
      try {
        found = await extract(`${title}\nДата: ${starts}${ends && ends !== starts ? ` – ${ends}` : ""}${time ? `, ${time}` : ""}\nМісце: ${where}\n\n${text.slice(0, 4000)}`, url);
      } catch (e) {
        out.errors.push(`${slug}: ${e.message}`);
        continue;
      }
      found.forEach((e, i) => {
        const ev = { source: "eventmate", key: `${slug.slice(0, 80)}${i ? `-${i}` : ""}`, ...e, url };
        const twin = findSimilar({ starts: e.starts, city: e.city, title: e.title, time: e.time });
        if (twin && twin.id !== `eventmate:${ev.key}`) {
          // The same event from a Telegram post: it gets this page as its link (we never show a post).
          if (!dry && linkKind(twin.url) === "tg") relinked += db.prepare("UPDATE cal_events SET url = ? WHERE id = ?").run(url, twin.id).changes;
          return out.dupes.push({ title: e.title, twin: twin.id });
        }
        if (!dry) upsert(ev);
        out.made.push({ title: e.title, starts: e.starts, city: e.city, named: e.named });
      });
    }
    // Seen addresses are kept half a year (an event's page doesn't come back).
    const old = addDays(today, -180);
    for (const [k, d] of Object.entries(seen)) if (d < old) delete seen[k];
    if (!dry) setMeta("eventmate:seen", JSON.stringify(seen)), setMeta("eventmate:relink", out.at);
    if (relinked) fresh();
    out.relinked = relinked;
    if (!dry) setMeta("eventmate:last", JSON.stringify({ ...out, made: out.made.length }));
    return out;
  }

  // Organizers' calendars Max adds on /admin/events: read every 6 hours (feedsRun), their next 120 days in as source
  // `ics` (key `<feed>/<uid>`), kind and city from the feed when given; a meeting gone from the calendar goes here
  // too. No AI: an organizer's calendar is all events, and books and authors are found by name (upsert).
  db.exec("CREATE TABLE IF NOT EXISTS cal_feeds (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', page TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', added TEXT NOT NULL, last TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')");
  const feeds = () => db.prepare("SELECT * FROM cal_feeds ORDER BY name, id").all();
  async function readFeed(f) {
    const today = kyivDay();
    const until = addDays(today, 120);
    const prefix = `ics:${f.id}/`;
    try {
      const page = await fetchPage(f.url, { timeout: 15000, accept: "text/calendar, */*", max: 4 * 1024 * 1024 });
      if (!/BEGIN:VCALENDAR/i.test(page.html)) throw new Error("це не календар (.ics)");
      const keep = new Set();
      for (const e of parseIcs(page.html)) {
        const last = e.ends || e.starts;
        if (e.status === "CANCELLED" || last < today || e.starts > until || !e.title) continue;
        const key = `${f.id}/${require("crypto").createHash("sha1").update(`${e.uid}|${e.starts}`).digest("hex").slice(0, 12)}`;
        const id = upsert({ source: "ics", key, title: e.title, sub: e.sub.split("\n").find((l) => l.trim()) || "", place: e.place.split(",")[0], city: f.city || findCity(e.place) || "", starts: e.starts, ends: e.ends, time: e.time, url: /^https?:\/\//.test(e.url) ? e.url : f.page, kind: f.kind });
        if (id) keep.add(id);
      }
      let gone = 0;
      for (const r of db.prepare("SELECT id FROM cal_events WHERE source = 'ics' AND id LIKE ? AND (starts >= ? OR ends >= ?)").all(`${prefix}%`, today, today))
        if (!keep.has(r.id)) gone += db.prepare("DELETE FROM cal_events WHERE id = ?").run(r.id).changes;
      if (gone) fresh();
      db.prepare("UPDATE cal_feeds SET last = ?, n = ?, error = '' WHERE id = ?").run(new Date().toISOString(), keep.size, f.id);
      return { id: f.id, n: keep.size, gone };
    } catch (e) {
      db.prepare("UPDATE cal_feeds SET last = ?, error = ? WHERE id = ?").run(new Date().toISOString(), String(e.message || e).slice(0, 200), f.id);
      return { id: f.id, error: e.message };
    }
  }
  async function feedsRun() {
    const out = [];
    for (const f of feeds()) out.push(await readFeed(f));
    return out;
  }
  // → { id } or { error } (Ukrainian, for the admin page).
  async function addFeed({ url, name, page, city, kind }) {
    const address = icsAddress(url);
    if (!address) return { error: "Потрібне посилання на календар: Google або .ics." };
    if (db.prepare("SELECT 1 FROM cal_feeds WHERE url = ?").get(address)) return { error: "Цей календар уже є." };
    const pg = /^https?:\/\//.test(String(page || "").trim()) && linkKind(page) !== "tg" ? String(page).trim().slice(0, 500) : "";
    const id = Number(db.prepare("INSERT INTO cal_feeds (url, name, page, city, kind, added) VALUES (?, ?, ?, ?, ?, ?)").run(address, clean(name, 80), pg, clean(city, 40), KINDS.some((k) => k.key === kind) ? kind : "", new Date().toISOString()).lastInsertRowid);
    const r = await readFeed(db.prepare("SELECT * FROM cal_feeds WHERE id = ?").get(id));
    // One that can't be read at once isn't kept: Max sees why and tries another link.
    if (r.error) removeFeed(id);
    return r.error ? { error: r.error } : { id, n: r.n };
  }
  // A calendar taken off, and its events with it.
  function removeFeed(id) {
    db.prepare("DELETE FROM cal_events WHERE source = 'ics' AND id LIKE ?").run(`ics:${Number(id)}/%`);
    db.prepare("DELETE FROM cal_feeds WHERE id = ?").run(Number(id));
    fresh();
  }

  // «Додати подію» from a reader: { title, url, starts, time, city, place, sub } → { id } or { error }.
  // A guest (`user` = { id: "guest:<hash of the address>", guest: true }, Max 2026-11-16) adds 3 a day, and the
  // event waits hidden for Max (`review`), with the e-mail they may leave (`f.contact`).
  function add(user, f) {
    const url = clean(f.url, 500);
    const title = clean(f.title, 160);
    if (title.length < 3) return { error: "Напишіть назву події." };
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return { error: "Додайте посилання на сторінку події." };
    if (!/^\d{4}-\d\d-\d\d$/.test(f.starts || "") || f.starts < kyivDay() || f.starts > addDays(kyivDay(), 400)) return { error: "Вкажіть дату події, не з минулого." };
    if (!clean(f.city, 40)) return { error: "Вкажіть місто або «Онлайн»." };
    if (abroad(f.city)) return { error: "Поки що тут лише події в Україні та онлайн." };
    const today = new Date().toISOString().slice(0, 10);
    if (!user.owner && db.prepare("SELECT count(*) n FROM cal_events WHERE by = ? AND added >= ?").get(user.id, today).n >= (user.guest ? 3 : 5)) return { error: "Сьогодні вже досить подій від вас. Завтра можна ще." };
    const contact = clean(f.contact, 120);
    if (user.guest && contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return { error: "Перевірте пошту або залиште поле порожнім." };
    // The same link on the same day in another city is a tour's next stop, not the same event.
    const dup = db.prepare("SELECT id FROM cal_events WHERE url = ? AND starts = ? AND city = ?").get(url, f.starts, clean(f.city, 40));
    if (dup) return { id: dup.id };
    const id = upsert({ source: "reader", key: require("crypto").randomBytes(5).toString("hex"), url, title, sub: f.sub, city: f.city, place: f.place, starts: f.starts, ends: f.ends, time: f.time, by: user.id, hidden: !!user.guest });
    if (!id) return { error: "Не вийшло зберегти. Перевірте дату." };
    if (user.guest) db.prepare("UPDATE cal_events SET review = 1, contact = ? WHERE id = ?").run(contact, id);
    return { id, event: row(db.prepare("SELECT * FROM cal_events WHERE id = ?").get(id)) };
  }

  const one = (id) => row(db.prepare("SELECT * FROM cal_events WHERE id = ?").get(id));
  // An event already kept that is the same one told elsewhere (Є's site and its Telegram channel): the same day
  // and city, and an author in common or half the title's words. → the row or null.
  // Words every club or meeting has don't make two events one («Читацький клуб за книгою …» on the same day,
  // podii.io 2026-11-16): only the rest are compared.
  const EVENT_WORDS = /^(клуб\p{L}*|читацьк\p{L}*|книжков\p{L}*|книги|книга|книгою|книжк\p{L}*|обговоренн\p{L}*|зустріч\p{L}*|засіданн\p{L}*|презентаці\p{L}*|роман\p{L}{0,2}|читанн\p{L}*|вечір|вечірка|творча|лекці\p{L}*|львові|києві|онлайн)$/u;
  const wordsOf = (t) => new Set((String(t || "").toLowerCase().replace(/['’ʼ‘`]/g, "").match(/[\p{L}\d]{4,}/gu) || []).filter((w) => !EVENT_WORDS.test(w)));
  const quoted = (t) => new Set([...String(t || "").matchAll(/[«"“„]([^»"”“]+)[»"”“]/g)].flatMap((m) => [...wordsOf(m[1])].map((w) => w.slice(0, 5))));
  // The same hour too (`time`): one word of the book's title in common is enough («Окупація» О. Слонєвського and
  // «Окупація Дніпродзержинська-Кам'янського 1941–1943 рр.», Кам'янське, 14:00, 2026-11-20).
  function sameEvent(p, r) {
    if (p.city && r.city && apos(r.city) !== apos(p.city)) return false;
    if (p.slugs.some((s) => r.authors.includes(s))) return true;
    const theirs = wordsOf(r.title);
    const common = [...p.words].filter((w) => theirs.has(w)).length;
    if (common && common >= Math.min(p.words.size, theirs.size) / 2) return true;
    // The same book in «» in another case: «Двір розколотої гармонії» and «Двором розколотої гармонії».
    const theirsQ = quoted(r.title);
    const commonQ = [...p.quoted].filter((w) => theirsQ.has(w)).length;
    if (commonQ >= 2 && commonQ >= Math.min(p.quoted.size, theirsQ.size) / 2) return true;
    return !!(commonQ && p.time && r.time === p.time && p.city && r.city);
  }
  const probe = ({ city = "", title = "", authors = null, time = "" }) => ({ city, time, words: wordsOf(title), quoted: quoted(title), slugs: authors || linkText(store, title).authors });
  function findSimilar({ starts, city = "", title = "", authors = null, time = "" }) {
    const p = probe({ city, title, authors, time });
    for (const r of db.prepare("SELECT * FROM cal_events WHERE starts = ?").all(starts).map(row)) if (sameEvent(p, r)) return r;
    return null;
  }
  // The same event twice on the calendar (came in before findSimilar knew apostrophes and the hour, 2026-11-20): the
  // one with a place (else the first in) stays, the rest are hidden. Once (meta `calendar:dedupe`); hidden ids in it.
  function dedupe() {
    const today = kyivDay();
    const rows = db.prepare("SELECT * FROM cal_events WHERE hidden = 0 AND starts >= ? ORDER BY starts, (place = ''), added").all(today).map(row);
    const gone = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (gone.includes(a.id)) continue;
      const p = probe(a);
      for (let j = i + 1; j < rows.length && rows[j].starts === a.starts; j++) if (!gone.includes(rows[j].id) && sameEvent(p, rows[j])) gone.push(rows[j].id);
    }
    const hideRow = db.prepare("UPDATE cal_events SET hidden = 1 WHERE id = ?");
    for (const id of gone) hideRow.run(id);
    if (gone.length) fresh();
    return gone;
  }
  if (!meta("calendar:dedupe")) {
    try {
      setMeta("calendar:dedupe", JSON.stringify({ at: new Date().toISOString(), hidden: dedupe() }));
    } catch {}
  }
  // podii.io's collector is gone (Max 2026-11-20: 1 event in 3 days); its events stay, its notes go.
  db.prepare("DELETE FROM meta WHERE key IN ('podii:seen', 'podii:last')").run();
  // A Telegram post says it is cancelled or moved (Max 2026-11-15): hidden, with why and which post said so, for
  // /admin/events. `how`: "cancelled" or "moved:<new day>".
  function cancel(id, how, post = "") {
    db.prepare("UPDATE cal_events SET hidden = 1, cancelled = ? WHERE id = ?").run(JSON.stringify({ how, post, at: new Date().toISOString() }), id);
    fresh();
  }
  // Back on the calendar (Max, when a post was read wrong).
  function uncancel(id) {
    db.prepare("UPDATE cal_events SET hidden = 0, cancelled = '' WHERE id = ?").run(id);
    fresh();
  }
  const cancelledList = () => {
    const today = kyivDay();
    return db
      .prepare("SELECT * FROM cal_events WHERE cancelled != '' AND (starts >= ? OR ends >= ?) ORDER BY starts LIMIT 100")
      .all(today, today)
      .map((r) => ({ ...row(r), cancelled: JSON.parse(r.cancelled || "{}") }));
  };
  // What came in lately, newest first, hidden ones too (/admin/events «Нові»: Max checks the collectors work).
  const recent = (days = 3, limit = 150) => {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    return db.prepare("SELECT * FROM cal_events WHERE added >= ? ORDER BY added DESC LIMIT ?").all(since, limit).map(row);
  };
  // Guests' events waiting for Max (/admin/events): upcoming ones; a past one just waits for cleanup.
  const pending = () => {
    const today = kyivDay();
    return db
      .prepare("SELECT * FROM cal_events WHERE review = 1 AND (starts >= ? OR ends >= ?) ORDER BY added LIMIT 100")
      .all(today, today)
      .map((r) => ({ ...row(r), contact: r.contact }));
  };
  // Max's answer to one: shown on the calendar, or gone.
  function review(id, show) {
    if (show) db.prepare("UPDATE cal_events SET hidden = 0, review = 0 WHERE id = ? AND review = 1").run(id);
    else db.prepare("DELETE FROM cal_events WHERE id = ? AND review = 1").run(id);
    fresh();
  }
  function hide(id) {
    db.prepare("UPDATE cal_events SET hidden = 1 WHERE id = ?").run(id);
    fresh();
  }
  // Max's link for an event (/admin/events), '' takes it off. The other events from the same post (a series of
  // meetings, a tour) get it too. → how many events, or null for a bad link.
  function setLink(id, link) {
    link = clean(link, 500);
    if (link && (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(link) || linkKind(link) === "tg")) return null;
    const e = db.prepare("SELECT url FROM cal_events WHERE id = ?").get(id);
    if (!e) return null;
    const n = e.url
      ? db.prepare("UPDATE cal_events SET link = ? WHERE url = ? AND (starts >= ? OR ends >= ?)").run(link, e.url, kyivDay(), kyivDay()).changes
      : db.prepare("UPDATE cal_events SET link = ? WHERE id = ?").run(link, id).changes;
    fresh();
    return n;
  }
  function cleanup() {
    const before = addDays(kyivDay(), -KEEP_DAYS);
    const r = db.prepare("DELETE FROM cal_events WHERE max(starts, ends) < ? AND ((authors = '[]' AND books = '[]') OR hidden = 1 OR max(starts, ends) < ?)").run(before, addDays(kyivDay(), -KEEP_LINKED_DAYS));
    db.prepare("DELETE FROM cal_going WHERE event NOT IN (SELECT id FROM cal_events)").run();
    db.prepare("DELETE FROM cal_watch_sent WHERE event NOT IN (SELECT id FROM cal_events)").run();
    fresh();
    return r.changes;
  }
  // web/seed/calendar.json at every start: [{ key, title, sub, url, city, place, starts, ends, time }]. An entry with
  // `fix` (an event's id) corrects a collected event instead: only the fields it names (Max 2026-11-17, the Kyiv stop
  // of Дронь's tour is at «Фундамент», Український дім). A collector writes a post's events once, so the fix stays.
  const FIXABLE = ["place", "sub", "time", "city", "starts", "ends"];
  function seed() {
    let list = [];
    try {
      list = require("./seed/calendar.json");
    } catch {}
    let n = 0;
    for (const e of list) {
      if (e.fix) {
        const keys = FIXABLE.filter((k) => typeof e[k] === "string");
        if (keys.length && db.prepare(`UPDATE cal_events SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => e[k]), e.fix).changes) n++;
      } else if (upsert({ ...e, source: "seed" })) n++;
    }
    if (n) fresh();
    return n;
  }

  // An event by the key at the end of its page's address (eventPath), hidden or past ones too (they go 30 days after).
  // A few hundred rows, each id hashed once.
  const keys = new Map();
  function byKey(k) {
    for (const { id } of db.prepare("SELECT id FROM cal_events").all()) {
      if (!keys.has(id)) keys.set(id, eventKey(id));
      if (keys.get(id) === k) return one(id);
    }
    return null;
  }

  // The next events with this author or book (by an author of the book when none names it), soonest first.
  const forAuthor = (slug, n = 3) => upcoming().filter((e) => e.authors.includes(slug)).slice(0, n);
  // The author's events that are over, newest first (kept a year, cleanup).
  const pastForAuthor = (slug, n = 3) =>
    db
      .prepare("SELECT * FROM cal_events WHERE hidden = 0 AND cancelled = '' AND max(starts, ends) < ? AND authors LIKE ? ORDER BY starts DESC LIMIT 20")
      .all(kyivDay(), `%${JSON.stringify(slug)}%`)
      .map(row)
      .filter((e) => e.authors.includes(slug))
      .slice(0, n);
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

  // «Підписатися» by e-mail (Max 2026-11-15, like a publisher's): a reader keeps the page's choice (kind, city,
  // «Мої автори», words), and the Friday letter brings the events it picks (digest.js). A few a reader.
  db.exec("CREATE TABLE IF NOT EXISTS cal_subs (reader TEXT NOT NULL, filter TEXT NOT NULL, added TEXT NOT NULL, PRIMARY KEY (reader, filter))");
  const subs = (reader) => (reader ? db.prepare("SELECT filter FROM cal_subs WHERE reader = ? ORDER BY added").all(reader).map((r) => subParse(r.filter)) : []);
  const subscribed = (reader, f) => !!reader && !!db.prepare("SELECT 1 FROM cal_subs WHERE reader = ? AND filter = ?").get(reader, subKey(f));
  const subscribe = (reader, f, on) => {
    if (!on) return db.prepare("DELETE FROM cal_subs WHERE reader = ? AND filter = ?").run(reader, subKey(f)).changes > 0;
    if (db.prepare("SELECT COUNT(*) AS n FROM cal_subs WHERE reader = ?").get(reader).n >= MAX_SUBS) return false;
    return db.prepare("INSERT OR IGNORE INTO cal_subs (reader, filter, added) VALUES (?, ?, ?)").run(reader, subKey(f), new Date().toISOString()).changes > 0;
  };
  const unsubscribeAll = (reader) => db.prepare("DELETE FROM cal_subs WHERE reader = ?").run(reader).changes;

  // «Хочу піти» (Max 2026-11-16, in place of «Додати в календар»: we see who is going): a reader's mark on an event,
  // and a letter the day before (`reminded` = when it went). Rows go with their event (cleanup) or the reader.
  // A reader who said «не нагадувати» has meta `calremind:off:<id>`.
  db.exec("CREATE TABLE IF NOT EXISTS cal_going (reader TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, reminded TEXT NOT NULL DEFAULT '', PRIMARY KEY (reader, event))");
  db.exec("CREATE INDEX IF NOT EXISTS cal_going_event ON cal_going (event)");
  const isGoing = (reader, id) => !!reader && !!db.prepare("SELECT 1 FROM cal_going WHERE reader = ? AND event = ?").get(reader, id);
  const goingCount = (id) => db.prepare("SELECT COUNT(*) AS n FROM cal_going WHERE event = ?").get(id).n;
  function going(reader, id, on) {
    if (!reader || !one(id)) return false;
    if (!on) return db.prepare("DELETE FROM cal_going WHERE reader = ? AND event = ?").run(reader, id).changes > 0;
    return db.prepare("INSERT OR IGNORE INTO cal_going (reader, event, at) VALUES (?, ?, ?)").run(reader, id, new Date().toISOString()).changes > 0;
  }
  // Events most readers mean to go to (/admin/events), upcoming ones.
  const goingTop = (limit = 20) => {
    const today = kyivDay();
    return db
      .prepare("SELECT e.*, COUNT(*) AS going FROM cal_going g JOIN cal_events e ON e.id = g.event WHERE (e.starts >= ? OR e.ends >= ?) GROUP BY e.id ORDER BY going DESC, e.starts LIMIT ?")
      .all(today, today, limit)
      .map((r) => ({ ...row(r), going: r.going }));
  };
  const remindOff = (reader) => meta(`calremind:off:${reader}`) === "1";
  const setRemind = (reader, on) => (on ? db.prepare("DELETE FROM meta WHERE key = ?").run(`calremind:off:${reader}`) : setMeta(`calremind:off:${reader}`, "1"));
  // Tomorrow's events (Kyiv) not reminded yet: { reader: [event] }, shown and not cancelled.
  function dueReminders() {
    const tomorrow = addDays(kyivDay(), 1);
    const by = new Map();
    for (const r of db.prepare("SELECT g.reader, e.* FROM cal_going g JOIN cal_events e ON e.id = g.event WHERE e.starts = ? AND e.hidden = 0 AND e.cancelled = '' AND g.reminded = ''").all(tomorrow)) {
      if (remindOff(r.reader)) continue;
      if (!by.has(r.reader)) by.set(r.reader, []);
      by.get(r.reader).push(row(r));
    }
    return by;
  }
  const reminded = (reader, ids) => {
    const up = db.prepare("UPDATE cal_going SET reminded = ? WHERE reader = ? AND event = ?");
    const at = new Date().toISOString();
    for (const id of ids) up.run(at, reader, id);
  };

  // «Стежити за подіями автора» (Max 2026-11-16, an empty search for «Артур Дронь»; authors only, «стежити за книжкою
  // це тупо»): a reader follows an author (slug) and gets a letter when an event with them comes (dueWatch, the hourly
  // `calendar-watch` job in server.js). Each event once a reader (cal_watch_sent); 30 a reader. `kind` stays in the
  // table for a later kind of follow.
  db.exec("CREATE TABLE IF NOT EXISTS cal_watch (reader TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, kind, ref))");
  db.exec("CREATE TABLE IF NOT EXISTS cal_watch_sent (reader TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, event))");
  const WATCH_MAX = 30;
  const watching = (reader) => (reader ? db.prepare("SELECT kind, ref, at FROM cal_watch WHERE reader = ? ORDER BY at").all(reader) : []);
  const isWatching = (reader, kind, ref) => !!reader && !!db.prepare("SELECT 1 FROM cal_watch WHERE reader = ? AND kind = ? AND ref = ?").get(reader, kind, ref);
  function watch(reader, kind, ref, on) {
    if (!reader || kind !== "author" || !ref) return false;
    if (!on) return db.prepare("DELETE FROM cal_watch WHERE reader = ? AND kind = ? AND ref = ?").run(reader, kind, ref).changes > 0;
    if (watching(reader).length >= WATCH_MAX) return false;
    return db.prepare("INSERT OR IGNORE INTO cal_watch (reader, kind, ref, at) VALUES (?, ?, ?, ?)").run(reader, kind, ref, new Date().toISOString()).changes > 0;
  }
  const unwatchAll = (reader) => db.prepare("DELETE FROM cal_watch WHERE reader = ?").run(reader).changes;
  // Upcoming shown events with authors readers follow, not sent to them yet: Map reader → [{ event, why: [{kind, ref}] }].
  function dueWatch() {
    const by = new Map();
    const all = db.prepare("SELECT reader, kind, ref FROM cal_watch WHERE kind = 'author'").all();
    if (!all.length) return by;
    const sent = db.prepare("SELECT 1 FROM cal_watch_sent WHERE reader = ? AND event = ?");
    const events = upcoming().filter((e) => !e.cancelled);
    for (const e of events) {
      for (const w of all) {
        if (!e.authors.includes(w.ref)) continue;
        if (sent.get(w.reader, e.id)) continue;
        if (!by.has(w.reader)) by.set(w.reader, new Map());
        const m = by.get(w.reader);
        if (!m.has(e.id)) m.set(e.id, { event: e, why: [] });
        m.get(e.id).why.push({ kind: w.kind, ref: w.ref });
      }
    }
    return new Map([...by].map(([r, m]) => [r, [...m.values()]]));
  }
  const watchSent = (reader, ids) => {
    const add = db.prepare("INSERT OR IGNORE INTO cal_watch_sent (reader, event, at) VALUES (?, ?, ?)");
    const at = new Date().toISOString();
    for (const id of ids) add.run(reader, id, at);
  };
  return { pastForAuthor, watching, isWatching, watch, unwatchAll, dueWatch, watchSent, upsert, setKinds, add, one, byKey, findSimilar, cancel, uncancel, cancelledList, recent, pending, review, hide, setLink, cleanup, seed, upcoming, forAuthor, forBook, cities, fillBooks, chytomoRun, eventmateRun, feeds, addFeed, removeFeed, feedsRun, yeRun, yeLast: () => yeLast, peek, fresh, meta, setMeta, subs, subscribed, subscribe, unsubscribeAll, going, isGoing, goingCount, goingTop, dueReminders, reminded, remindOff, setRemind };
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

// The events as an iCalendar feed (RFC 5545), for «Підписатися» in a phone's calendar: a timed event lasts two
// hours in Kyiv time, a day without a time is all-day (to its last day). Lines fold at 75 bytes.
function ics(events, { name = "Книжкові події", site = "https://chytai.org.ua" } = {}) {
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
  const fold = (line) => {
    const out = [];
    let cur = "";
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > 74) (out.push(cur), (cur = " "));
      cur += ch;
    }
    return [...out, cur].join("\r\n");
  };
  const d8 = (day) => day.replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chytai//Knyzhkovi podii//UK", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(name)}`, "X-WR-TIMEZONE:Europe/Kyiv", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id.replace(/[^\w.:-]/g, "-")}@chytai.org.ua`, `DTSTAMP:${stamp}`);
    if (e.time) {
      const [h, m] = e.time.split(":").map(Number);
      const endH = Math.min(h + 2, 23);
      lines.push(`DTSTART;TZID=Europe/Kyiv:${d8(e.starts)}T${pad(h)}${pad(m)}00`, `DTEND;TZID=Europe/Kyiv:${d8(e.starts)}T${pad(endH)}${pad(endH === 23 && h + 2 > 23 ? 59 : m)}00`);
    } else lines.push(`DTSTART;VALUE=DATE:${d8(e.starts)}`, `DTEND;VALUE=DATE:${d8(addDays(e.ends || e.starts, 1))}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    const where = e.city === "Онлайн" ? "Онлайн" : [e.place, e.city].filter(Boolean).join(", ");
    if (where) lines.push(`LOCATION:${esc(where)}`);
    const src = sourceUrl(e);
    lines.push(`DESCRIPTION:${esc([e.sub, src ? `Організатор: ${src}` : "", `На Chytai: ${site}${eventPath(e)}`].filter(Boolean).join("\n"))}`);
    lines.push(`URL:${src || `${site}${eventPath(e)}`}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// A subscription's choice as one stored string, always in the same order: kind, city, mine, q.
const MAX_SUBS = 10;
function subKey({ kind = "", city = "", mine = false, q = "" } = {}) {
  const p = new URLSearchParams();
  if (kind) p.set("kind", String(kind).slice(0, 20));
  if (city) p.set("city", String(city).slice(0, 40));
  if (mine) p.set("mine", "1");
  const words = String(q || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (words) p.set("q", words);
  return p.toString();
}
function subParse(s) {
  const p = new URLSearchParams(s);
  return { kind: p.get("kind") || "", city: p.get("city") || "", mine: p.get("mine") === "1", q: p.get("q") || "" };
}
// What a subscription picks, in a few words: «Книжкові клуби · Київ · мої автори · «Жадан»», or «Усі події».
function subName(f) {
  const kind = KINDS.find((k) => k.key === f.kind);
  return [kind?.label, f.city, f.mine ? "мої автори" : "", f.q ? `«${f.q}»` : ""].filter(Boolean).join(" · ") || "Усі події";
}

// An event's own page (Max 2026-11-15: a club on /calendar led to a filtered list): /calendar/<title>-<key>, the key
// 8 hex of the id's hash, so the address stays when the title is corrected (the old one redirects).
const eventKey = (id) => require("crypto").createHash("sha1").update(String(id)).digest("hex").slice(0, 8);
// A short address (Max 2026-11-17: «прям довгі»): the book or club name in quotes, else the title without the words
// every event has, at most 4 words and 32 letters. «Презентація книги «Лікарня святого Пантелеймона» Артура Дроня» →
// /calendar/likarnia-sviatoho-panteleimona-4c1af9bd. The key alone finds the event: older, longer ones redirect.
const SLUG_SKIP = /^(презентаці[яїю]|зустріч[іь]?|з|із|зі|та|і|й|а|на|в|у|про|до|по|для|від|за|книг[иау]|книжк[иау]|книжок|роману|збірки|нов(ої|ою|ого|а)|обговорення|обговорюємо|онлайн|спільне|читання|лекці[яїю]|розмова|читацьк\S*|книжков\S*|клуб[уі]?|літературн\S*|авторськ\S*|творч\S*|вечір|письменниц\S*|письменник\S*|поет\S*|програма|фестиваль)$/i;
function eventSlug(e) {
  const { slugify } = require("./store");
  const title = tourTitle(e);
  const q = title.match(/[«"“„]([^»"”“]{3,})[»"”“]/);
  const words = (q ? q[1] : title).split(/[\s.,:;!?()–—-]+/).filter(Boolean);
  const kept = q ? words : words.filter((w) => !SLUG_SKIP.test(w));
  let out = "";
  for (const w of kept.length ? kept : words) {
    const s = slugify(w);
    if (!s) continue;
    if (out && out.length + 1 + s.length > 32) break;
    out = out ? `${out}-${s}` : s.slice(0, 32);
    if (out.split("-").length >= 4) break;
  }
  return out.replace(/-+$/, "");
}
const eventPath = (e) => `/calendar/${[eventSlug(e), eventKey(e.id)].filter(Boolean).join("-")}`;
// What the organizer's link is, for its button: a sign-up form, a Telegram post, or a site.
function linkKind(url) {
  if (/^https?:\/\/(forms\.gle|docs\.google\.com\/forms|forms\.office\.com|[^/]*typeform\.com|[^/]*jotform\.com)/i.test(url || "")) return "form";
  if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(url || "")) return "tg";
  if (/^https?:\/\/([^/]*\.)?(instagram\.com|facebook\.com|fb\.me)\//i.test(url || "")) return "social";
  if (/^https?:\/\/book-ye\.com\.ua\/calendar\/[a-z-]+\/?$/i.test(url || "")) return "ye";
  // A news site's piece about the event (Chytomo's article on a whole festival): no organizer's page (Max 2026-11-16).
  if (/^https?:\/\/(www\.)?chytomo\.com\//i.test(url || "")) return "news";
  return url ? "site" : "";
}
// Книгарня «Є»'s afisha by city (book-ye.com.ua/calendar/<city>/; slugs seen on their site 2026-11-15). Their site
// lets no robot in (Cloudflare's check, even in Max's Chrome), so we can't find the event's own page there.
const YE_CITY = { Київ: "kyyiv", Львів: "lviv", "Івано-Франківськ": "ivano-frankivsk", Чернігів: "chernihiv", Ужгород: "uzhhorod" };
const isYe = (e) => /Книгарн[яіи]\s+[«"]?Є\b|[«"]Є[»"]/.test(`${e?.place || ""} ${e?.title || ""} ${e?.by || ""}`);
// The link readers see. Never a Telegram post (Max 2026-11-15: it tells we read channels, and the organizer has a page
// somewhere): Max's own link first (/admin/events), an event at «Є» gets its city's afisha there, the rest the
// channel itself, not the post (Max: «хай шукають»).
function sourceUrl(e) {
  if (e?.link) return e.link;
  if (linkKind(e?.url) !== "tg") return e?.url || "";
  const city = YE_CITY[e?.city];
  if (city && isYe(e)) return `https://book-ye.com.ua/calendar/${city}/`;
  return tgChannel(e.url);
}
// t.me/<channel>/<post> → t.me/<channel>; an invite (t.me/+…) is the channel already; a private post (t.me/c/…) → ''.
function tgChannel(url) {
  const m = String(url || "").match(/^https?:\/\/(?:t\.me|telegram\.me)\/(\+[\w-]+|joinchat\/[\w-]+|[a-z][\w]{3,31})(?:\/|$|\?)/i);
  return m && m[1].toLowerCase() !== "c" && m[1].toLowerCase() !== "s" ? `https://t.me/${m[1]}` : "";
}
// One event's Google Calendar link (the .ics file is /calendar/<…>.ics): a timed event lasts two hours.
function googleLink(e, page = "") {
  const d8 = (day) => day.replace(/-/g, "");
  let dates;
  if (e.time) {
    const [h, m] = e.time.split(":").map(Number);
    const endH = Math.min(h + 2, 23);
    dates = `${d8(e.starts)}T${pad(h)}${pad(m)}00/${d8(e.starts)}T${pad(endH)}${pad(endH === 23 && h + 2 > 23 ? 59 : m)}00`;
  } else dates = `${d8(e.starts)}/${d8(addDays(e.ends || e.starts, 1))}`;
  const where = e.city === "Онлайн" ? "Онлайн" : [e.place, e.city].filter(Boolean).join(", ");
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, ctz: "Europe/Kyiv", details: [e.sub, page].filter(Boolean).join("\n\n"), location: where });
  return `https://calendar.google.com/calendar/render?${p}`;
}

const SHORT_DAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const shortWhen = (e) => `${SHORT_DAYS[new Date(`${e.starts}T12:00:00Z`).getUTCDay()]}, ${span(e)}`;

module.exports = { create, KINDS, parseIcs, icsAddress, abroad, presentation, eventKey, eventPath, linkKind, sourceUrl, googleLink, tourTitle, subKey, subParse, subName, SHORT_DAYS, tours, ics, parseWhen, linkText, readEvent, cleanTitle, findCity, kyivDay, addDays, dayName, dayAside, span, shortWhen, MONTHS };
