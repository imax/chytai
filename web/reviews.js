// «Про цю книжку писали»: what Ukrainian sites and BookTube channels wrote or said about a book, as
// links on its page (Max, 2026-10-22: «додавати посилання на огляд книжки прямо на сторінку книжки»).
// Only a link, the title, the date and one short sentence are shown, never the text itself: a quote
// with its source is free to use, a copy of a review is not (Закон 2811-IX).
//
// Sources: a site's RSS (Читомо), a WordPress archive read once (ЛітАкцент, closed in 2022) and
// YouTube channels. YouTube stopped serving channel RSS (404 since 2026), so a channel's /videos page
// gives the latest video ids and each new video's page its title, date and description.
//
// Which books an item is about: the title and the start of the text are searched for the titles of
// our works, and a title counts only when the author's surname is there too (in any case form:
// «Жадана», «Кузнєцової»). Every item is kept with
// its text, so a new book in the catalog or a better matcher finds old items on the next pass. A one-word
// title without quotes needs the name within four words of it («Інтернат Сергія Жадана»).
const { norm, soundOf, isRussian } = require("./store");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Accept-Language": "uk,en;q=0.5" };
// The EU consent page stands in front of YouTube for a server in Frankfurt; SOCS=CAI is «reject all».
const YT_HEADERS = { ...HEADERS, Cookie: "SOCS=CAI; CONSENT=PENDING+987" };

// New sources start as drafts: only the owner sees their links until Max has looked at them.
const yt = (id, name, channel) => ({ id: `yt-${id}`, name, kind: "youtube", channel, url: `https://www.youtube.com/channel/${channel}`, draft: true });
const SOURCES = [
  { id: "chytomo", name: "Читомо", kind: "site", feed: "https://chytomo.com/feed/", url: "https://chytomo.com/", draft: true },
  { id: "litakcent", name: "ЛітАкцент", kind: "site", archive: (n) => `https://litakcent.online/category/recenzija/feed/?paged=${n}`, url: "https://litakcent.online/", draft: true },
  // Ukrainian BookTube: the jury of the book bloggers' award (Книжкова країна, 2026) and the larger
  // channels found by a YouTube search on 2026-10-22.
  yt("prolit", "Проліт", "UCMw_BiVMRQ4N9txZ1o_MlSA"),
  yt("peake-week", "Peake-week Papers", "UCxc_X8K5gOpls_0uXcCXtbA"),
  yt("romanska", "Дарина Романська", "UCmRNxrYo9mWATIETKjYGAgQ"),
  yt("vyshnevyi-tsvit", "Вишневий Цвіт", "UC74_-1ivw94o2O0xH74YlDQ"),
  yt("petro-chtyvo", "Petro Chtyvo", "UCH2QKLE7ET2M_43aZvPtfOg"),
  yt("sashabooks", "SashaBooks", "UCpSFfGB8NGDv0onNz82VBlA"),
  yt("persyk", "Діма Персик і книги", "UCXh-KoO4zZsCT_uRsCsVSXQ"),
  yt("knyhodzhungli", "Книгоджунглі", "UCeoAVcGzOKRw27SFJtpA7YA"),
  yt("knyzhiulia", "книжЮля", "UC8d2SbiRrT4d-wFR0sR3Qjg"),
  yt("znovu", "знову ті її книжки", "UCrnYhHrcrcjZpgW0o-6oRWA"),
  yt("svitlo-bibliotek", "Svitlo Bibliotek", "UCiC-mxz5_AMiNzSMbKcEgDQ"),
];
const byId = new Map(SOURCES.map((s) => [s.id, s]));
const EVERY_MS = 6 * 3600 * 1000;
const NEW_VIDEOS = 30; // the newest videos of a channel looked at per pass (its whole /videos page)

const SCHEMA = `CREATE TABLE IF NOT EXISTS reviews (
  url TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, date TEXT, quote TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', works TEXT NOT NULL DEFAULT '[]', seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_source ON reviews (source, date);`;

// ---- text ----
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
const decode = (s) => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const plain = (html) => decode(String(html || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t ]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
const tag = (xml, name) => (xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)) || [])[1] || "";
const cdata = (s) => String(s).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");

// The one sentence shown under a link: the first sentence of the lead that says something (not a link
// list, not «Підписуйтесь»), at most 200 characters, cut at a word.
const JUNK = /https?:\/\/|підписуй|subscribe|instagram|telegram|tiktok|патреон|patreon|донат|monobank|промокод|реклам|таймкод|00:00|^#/i;
function quoteOf(text) {
  for (const line of String(text).split(/\n+/)) {
    const t = line.trim();
    if (t.length < 25 || JUNK.test(t)) continue;
    const sentence = (t.match(/^.{25,}?[.!?…](?=\s|$)/) || [t])[0];
    if (sentence.length <= 200) return sentence;
    return sentence.slice(0, 200).replace(/\s+\S*$/, "") + "…";
  }
  return "";
}

// ---- reading the sources ----
async function get(url, headers = HEADERS, tries = 3) {
  let res;
  for (let i = 1; ; i++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: "follow" });
      if (res.status < 500 || i >= tries) break;
    } catch (e) {
      if (i >= tries) throw new Error(`${e.cause?.code || e.message} on ${url}`);
    }
    await sleep(5000 * i);
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} on ${url}`), { status: res.status });
  return res.text();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An RSS page's items: { url, title, date, quote, text }. The text is the title, the lead and the start
// of the article: enough to say which books it is about.
function rssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const title = plain(cdata(tag(it, "title")));
    const lead = plain(cdata(tag(it, "description")));
    const body = plain(cdata(tag(it, "content:encoded")));
    const date = new Date(plain(tag(it, "pubDate")));
    return {
      url: plain(tag(it, "link")),
      title,
      date: isNaN(date) ? null : date.toISOString().slice(0, 10),
      quote: quoteOf(lead.replace(/\s*(The post|Запис|Читати далі)[\s\S]*$/, "")) || quoteOf(body),
      text: [title, lead, body].join("\n").slice(0, 6000),
    };
  });
}

// The JSON a YouTube page sets up for itself (ytInitialData, ytInitialPlayerResponse).
function ytJson(html, name) {
  const m = html.match(new RegExp(`var ${name} = (\\{[\\s\\S]*?\\});(?:var |</script>)`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
// «2 тижні тому», «3 weeks ago» -> the day it roughly was.
const AGO = [[/^(тиж|w)/, 7], [/^(міс|mo)/, 30], [/^(р|y)/, 365], [/^(д|d)/, 1], [/^(хв|год|сек|m|h|s)/, 0]];
function agoDate(s) {
  const m = String(s || "").match(/(\d+)\s*(\S+)/);
  const unit = m && AGO.find(([re]) => re.test(m[2]));
  return unit ? new Date(Date.now() - Number(m[1]) * unit[1] * 86400000).toISOString().slice(0, 10) : null;
}
// The latest videos of a channel from its /videos page: id, title and a rough date. No description
// there; that is on each video's own page (video()) or in the Data API (apiVideos()).
async function channelVideos(src) {
  const data = ytJson(await get(`https://www.youtube.com/channel/${src.channel}/videos?hl=uk`, YT_HEADERS), "ytInitialData");
  if (!data) throw new Error(`${src.id}: no ytInitialData on the channel page (a consent or bot page?)`);
  const out = [];
  JSON.stringify(data, (k, v) => {
    let it = null;
    if (k === "videoRenderer" && v?.videoId) it = { id: v.videoId, title: v.title?.runs?.map((r) => r.text).join("") || "", ago: v.publishedTimeText?.simpleText };
    if (k === "lockupViewModel" && v?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const parts = [];
      JSON.stringify(v.metadata || {}, (kk, vv) => (kk === "content" && typeof vv === "string" && parts.push(vv), vv));
      it = { id: v.contentId, title: v.metadata?.lockupMetadataViewModel?.title?.content || "", ago: parts.find((p) => /тому|ago/.test(p)) };
    }
    if (it && !out.some((o) => o.id === it.id)) out.push(it);
    return v;
  });
  return out.slice(0, NEW_VIDEOS).map((v) => ({ url: `https://www.youtube.com/watch?v=${v.id}`, title: v.title, date: agoDate(v.ago), quote: "", text: v.title, thin: true }));
}
// With a YouTube Data API key (YOUTUBE_API_KEY): the uploads playlist, with full descriptions and dates.
async function apiVideos(src, key) {
  const u = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${NEW_VIDEOS}&playlistId=UU${src.channel.slice(2)}&key=${encodeURIComponent(key)}`;
  const data = JSON.parse(await get(u, { "User-Agent": "Chytai/1.0 (https://chytai.org.ua)" }));
  return (data.items || [])
    .map((i) => i.snippet)
    .filter((sn) => sn?.resourceId?.videoId && sn.title !== "Private video")
    .map((sn) => ({ url: `https://www.youtube.com/watch?v=${sn.resourceId.videoId}`, title: sn.title, date: String(sn.publishedAt || "").slice(0, 10) || null, quote: quoteOf(sn.description), text: `${sn.title}\n${sn.description || ""}`.slice(0, 6000) }));
}
async function video(id) {
  const p = ytJson(await get(`https://www.youtube.com/watch?v=${id}&hl=uk`, YT_HEADERS), "ytInitialPlayerResponse");
  const d = p?.videoDetails;
  if (!d?.title) throw new Error(`video ${id}: no player response`);
  const desc = String(d.shortDescription || "");
  const date = p.microformat?.playerMicroformatRenderer?.publishDate || p.microformat?.playerMicroformatRenderer?.uploadDate || "";
  return { url: `https://www.youtube.com/watch?v=${id}`, title: d.title, date: date.slice(0, 10) || null, quote: quoteOf(desc), text: `${d.title}\n${desc}`.slice(0, 6000) };
}

// ---- which works an item is about ----
const words = (s) => norm(s).split(" ").filter(Boolean);
const latin = (w) => soundOf(w); // «Орвелла» and «Orwell» sound alike
// Common first names are never enough on their own: «Сергій» is not Жадан.
const FIRST_NAMES = new Set("сергій олександр андрій володимир юрій микола іван петро тарас василь дмитро максим ігор олег віктор марія олена оксана ірина наталія тетяна катерина юлія анна софія галина людмила john james george david michael robert william mary elizabeth stephen paul peter thomas richard".split(" ").map(soundOf));
// The parts of an author's name to look for: surnames, not initials or common first names.
function surnames(author) {
  return [
    ...new Set(
      String(author || "")
        .split(/[,;&]| та | і | and /)
        .flatMap((one) => words(one).map(latin))
        .filter((w) => w.length >= 3 && !FIRST_NAMES.has(w)),
    ),
  ];
}
// Does a word of the text name this surname, allowing a case ending (zhadana/zhadan, kuznietsovoi/kuznietsova)?
function namesIt(word, name) {
  if (word === name) return true;
  if (name.length < 4 || word.length < 4) return false;
  let i = 0;
  while (i < word.length && word[i] === name[i]) i++;
  return i >= Math.max(4, name.length - 2) && word.length - i <= 3;
}

class Matcher {
  // index: store.workIndex().byTitle (norm(title) -> [{ id, author }]); book(id) for the Russian check.
  constructor(byTitle, book) {
    this.first = new Map(); // first two words -> [{ key, words }]
    this.titles = byTitle;
    this.book = book;
    const names = new Map();
    this.surnames = (a) => names.get(a) || names.set(a, surnames(a)).get(a);
    const sounds = new Map();
    this.sound = (w) => sounds.get(w) ?? (sounds.size > 200000 && sounds.clear(), sounds.set(w, latin(w)).get(w));
    for (const key of byTitle.keys()) {
      const w = key.split(" ");
      if (w.length < 2 || key.length < 5) continue; // one-word titles are looked up word by word
      const two = `${w[0]} ${w[1]}`;
      (this.first.get(two) || this.first.set(two, []).get(two)).push({ key, words: w });
    }
  }
  // Works an item's text is about, as ids (canonical at the time).
  match(text) {
    const raw = String(text || "");
    const tokens = words(raw);
    const sound = tokens.map(this.sound);
    const found = new Set();
    // Titles in quotes, of any length: «Хорт», "Намул", “Інтернат”.
    const quotedKeys = new Set();
    for (const m of raw.matchAll(/[«“"„]([^«»“”"„\n]{2,120})[»”"“]/g)) if (this.titles.has(norm(m[1]))) found.add(norm(m[1])), quotedKeys.add(norm(m[1]));
    // Titles of two or more words anywhere in the text, and one-word titles without quotes («Інтернат
    // Сергія Жадана»), these only right next to their author's name. A title inside a longer one found
    // at the same place («Братство» in «Темний спадок. Братство») is the longer one's.
    const covered = new Uint16Array(tokens.length); // the longest title found over each word
    const spans = [];
    for (let i = 0; i < tokens.length; i++) {
      for (const c of this.first.get(`${tokens[i]} ${tokens[i + 1]}`) || []) {
        if (!c.words.every((w, j) => tokens[i + j] === w)) continue;
        spans.push([i, c.words.length, c.key]);
        for (let j = i; j < i + c.words.length; j++) covered[j] = Math.max(covered[j], c.words.length);
      }
      if (tokens[i].length >= 5 && !/^\d+$/.test(tokens[i]) && this.titles.has(tokens[i])) spans.push([i, 1, tokens[i]]), (covered[i] = Math.max(covered[i], 1));
    }
    const near = new Map(); // one-word key -> sound of the words around it
    for (const [i, len, key] of spans) {
      if (covered.subarray(i, i + len).some((c) => c > len)) continue;
      found.add(key);
      if (len === 1) (near.get(key) || near.set(key, []).get(key)).push(...sound.slice(Math.max(0, i - 4), i + 5));
    }
    if (!found.size) return [];
    // The text's words by their first four letters, so a surname is looked up, not searched for.
    const byStart = new Map();
    for (const t of sound) (byStart.get(t.slice(0, 4)) || byStart.set(t.slice(0, 4), new Set()).get(t.slice(0, 4))).add(t);
    const inText = (n) => [...(byStart.get(n.slice(0, 4)) || [])].some((t) => namesIt(t, n));
    const keys = [...found];
    const ids = [];
    for (const k of keys) {
      const quoted = k.includes(" ") || quotedKeys.has(k);
      for (const w of this.titles.get(k) || []) {
        const names = this.surnames(w.author);
        if (!names.length || !names.some((n) => (quoted ? inText(n) : (near.get(k) || []).some((t) => namesIt(t, n))))) continue;
        const b = this.book(w.id);
        if (!b || isRussian(b)) continue;
        if (!ids.includes(w.id)) ids.push(w.id);
      }
    }
    return ids;
  }
}

// ---- the store of items ----
class Reviews {
  constructor(store, { log = console.log } = {}) {
    this.store = store;
    this.db = store.db;
    this.log = log;
    this.db.exec(SCHEMA);
    this.db.exec("UPDATE OR IGNORE reviews SET url = replace(replace(url, 'http://litakcent.com/', 'https://litakcent.online/'), 'https://litakcent.com/', 'https://litakcent.online/') WHERE url LIKE '%litakcent.com/%'");
    this.running = null;
    this.status = JSON.parse(this.db.get("reviews:status") || "{}"); // source id -> { at, ok, error, added }
    this.index();
  }
  matcher() {
    return new Matcher(this.store.workIndex().byTitle, (id) => this.store.book(id));
  }
  // work id -> [item], newest first; rebuilt after every pass and when the works change.
  index() {
    const byWork = new Map();
    for (const r of this.db.prepare("SELECT url, source, title, date, quote, works FROM reviews WHERE works != '[]' ORDER BY date DESC").all()) {
      const src = byId.get(r.source);
      if (!src) continue;
      const item = { url: r.url, title: r.title, date: r.date, quote: r.quote, source: src.name, sourceId: src.id, kind: src.kind, draft: !!src.draft };
      for (const id of new Set(JSON.parse(r.works).map((w) => this.store.canonical(w)))) (byWork.get(id) || byWork.set(id, []).get(id)).push(item);
    }
    this.byWork = byWork;
  }
  // What was written about a work (and its editions), for its page; drafts only for the owner. The
  // owner's picks for the work come first, marked `picked` (Max, 2026-10-22: «обрати 1, 2, 3, які
  // показувати»); items he said are not about this book are gone.
  of(workId, { owner = false } = {}) {
    const id = this.store.canonical(workId);
    const picks = this.picks()[id] || [];
    const hidden = new Set(this.hidden()[id] || []);
    const items = (this.byWork.get(id) || []).filter((it) => (owner || !it.draft) && !hidden.has(it.url)).map((it) => ({ ...it, picked: picks.includes(it.url) }));
    return [...picks.map((u) => items.find((it) => it.url === u)).filter(Boolean), ...items.filter((it) => !it.picked)];
  }
  picks() {
    return JSON.parse(this.db.get("reviews:picks") || "{}"); // work id -> [url], at most 3, in order picked
  }
  hidden() {
    return JSON.parse(this.db.get("reviews:hidden") || "{}"); // work id -> [url]
  }
  // Show this item on the work's page or stop showing it; a fourth pick pushes out the first.
  pick(workId, url) {
    const id = this.store.canonical(workId);
    const all = this.picks();
    const list = all[id] || [];
    all[id] = list.includes(url) ? list.filter((u) => u !== url) : [...list, url].slice(-3);
    if (!all[id].length) delete all[id];
    this.db.set("reviews:picks", JSON.stringify(all));
  }
  // «Не про цю книжку»: a wrong match, off this work's page for good (the item stays for other books).
  hide(workId, url) {
    const id = this.store.canonical(workId);
    const all = this.hidden();
    all[id] = [...new Set([...(all[id] || []), url])];
    this.db.set("reviews:hidden", JSON.stringify(all));
    const picks = this.picks();
    if (picks[id]?.includes(url)) this.pick(id, url);
  }

  save(src, items, matcher) {
    const now = new Date().toISOString();
    const has = this.db.prepare("SELECT 1 FROM reviews WHERE url = ?");
    const put = this.db.prepare("INSERT INTO reviews (url, source, title, date, quote, text, works, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET title = excluded.title, date = COALESCE(excluded.date, date), quote = excluded.quote, text = excluded.text, works = excluded.works");
    let added = 0;
    this.db.tx(() => {
      for (const it of items) {
        if (!it.url || !it.title) continue;
        it.url = it.url.replace(/^https?:\/\/(www\.)?litakcent\.com\//, "https://litakcent.online/"); // the site is an archive now
        if (!has.get(it.url)) added++;
        put.run(it.url, src.id, it.title.slice(0, 300), it.date, it.quote, it.text, JSON.stringify(matcher.match(it.text)), now);
      }
    });
    return added;
  }

  async readSource(src, matcher) {
    if (src.feed) return this.save(src, rssItems(await get(src.feed)), matcher);
    if (src.archive) {
      // Read once, a page at a time; where it stopped is kept, so a deploy in the middle goes on from there.
      if (this.db.get(`reviews:${src.id}:done`)) return 0;
      let added = 0;
      for (let n = Number(this.db.get(`reviews:${src.id}:page`) || 1); n < 1000; n++) {
        let items;
        try {
          items = rssItems(await get(src.archive(n)));
        } catch (e) {
          if (e.status === 404 && n > 1) break;
          throw e;
        }
        if (!items.length) break;
        added += this.save(src, items, matcher);
        this.db.set(`reviews:${src.id}:page`, String(n + 1));
        await sleep(1500);
      }
      this.db.set(`reviews:${src.id}:done`, new Date().toISOString());
      return added;
    }
    if (src.kind === "youtube") {
      if (process.env.YOUTUBE_API_KEY) return this.save(src, await apiVideos(src, process.env.YOUTUBE_API_KEY), matcher);
      // Without a key: titles from the channel page, and the description from a video's own page while
      // YouTube lets us (from Fly it asks «are you a bot» after a few). A video kept with its title only
      // is tried again on the next pass, a few a pass.
      const have = this.db.prepare("SELECT text FROM reviews WHERE url = ?");
      const list = (await channelVideos(src)).filter((v) => {
        const row = have.get(v.url);
        return !row || !row.text.includes("\n");
      });
      const items = [];
      let tries = 0;
      for (const v of list) {
        if (!this.ytBlocked && tries < 5) {
          tries++;
          try {
            const full = await video(v.url.split("=")[1]);
            items.push({ ...full, date: full.date || v.date });
          } catch (e) {
            this.ytBlocked = true; // no more video pages this pass
            this.log(`reviews: ${src.id}: ${e.message}; titles only for now`);
            items.push(v);
          }
          await sleep(4000);
        } else items.push(v);
      }
      return this.save(src, items, matcher);
    }
    return 0;
  }

  // One pass over the sources not read in the last 6 hours (all with force).
  refresh({ force = false, only = "" } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const t0 = Date.now();
      const matcher = this.matcher();
      this.ytBlocked = false;
      for (const src of SOURCES) {
        if (only && src.id !== only) continue;
        const last = this.status[src.id];
        if (!force && last?.ok && Date.now() - Date.parse(last.at) < EVERY_MS - 600000) continue;
        try {
          const added = await this.readSource(src, matcher);
          this.status[src.id] = { at: new Date().toISOString(), ok: true, added };
          if (added) this.log(`reviews: ${src.id}: ${added} new`);
        } catch (e) {
          this.status[src.id] = { at: new Date().toISOString(), ok: false, error: String(e.message).slice(0, 300) };
          this.log(`reviews: ${src.id} failed: ${e.message}`);
        }
        this.db.set("reviews:status", JSON.stringify(this.status));
      }
      await this.rematch(matcher);
      this.log(`reviews: pass done in ${Math.round((Date.now() - t0) / 1000)} s`);
    })()
      .catch((e) => this.log(`reviews: pass failed: ${e.message}`))
      .finally(() => (this.running = null));
    return this.running;
  }

  // Match every kept item again: the catalog grows and the matcher changes.
  async rematch(matcher = this.matcher()) {
    const t0 = Date.now();
    const rows = this.db.prepare("SELECT url, text, works FROM reviews").all();
    const put = this.db.prepare("UPDATE reviews SET works = ? WHERE url = ?");
    const changes = [];
    for (let i = 0; i < rows.length; i++) {
      const works = JSON.stringify(matcher.match(rows[i].text));
      if (works !== rows[i].works) changes.push([works, rows[i].url]);
      if (i % 100 === 99) await new Promise((r) => setImmediate(r)); // let pages be served meanwhile
    }
    this.db.tx(() => changes.forEach(([works, url]) => put.run(works, url)));
    this.index();
    this.log(`reviews: rematched ${rows.length} items in ${Date.now() - t0} ms, ${changes.length} changed`);
  }

  // For the owner's page: every source with its state and the latest items with what they matched.
  report({ source = "", limit = 150 } = {}) {
    const counts = new Map(this.db.prepare("SELECT source, COUNT(*) n, SUM(works != '[]') matched FROM reviews GROUP BY source").all().map((r) => [r.source, r]));
    const sources = SOURCES.map((s) => ({ ...s, ...(this.status[s.id] || {}), items: counts.get(s.id)?.n || 0, matched: counts.get(s.id)?.matched || 0 }));
    const items = this.db
      .prepare(`SELECT url, source, title, date, quote, works FROM reviews ${source ? "WHERE source = ?" : ""} ORDER BY date DESC LIMIT ?`)
      .all(...(source ? [source, limit] : [limit]))
      .map((r) => ({ ...r, sourceName: byId.get(r.source)?.name || r.source, books: JSON.parse(r.works).map((id) => this.store.book(id)).filter(Boolean) }));
    return { sources, items, running: !!this.running };
  }

  start() {
    setTimeout(() => this.refresh(), 2 * 60 * 1000).unref();
    setInterval(() => this.refresh(), EVERY_MS).unref();
  }
}

module.exports = { Reviews, Matcher, SOURCES, rssItems, quoteOf, surnames, namesIt };
