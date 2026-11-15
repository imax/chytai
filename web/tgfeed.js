// Posts of public Telegram channels (publishers, bookstores, literary schools), kept 90 days, and the book events
// they announce for «Книжкові події» on /calendar (Max, 2026-11-15: «багато подій є в телеграм»; then «щоб він
// підписався на більшість телеграм каналів і буде сам отримувати свіжі пости. Може там не тільки події згодом
// будуть»). Telegram is only a source here: nothing reader-facing goes through it.
//
// Where the posts come from:
//   - our own Telegram account (not Max's personal one), through Telegram's API for programs (MTProto, the `telegram`
//     package = gramjs). It joins the channels in web/seed/tgchannels.json, a few a run, and each run asks for its
//     dialogs once: a channel whose last post is newer than ours gives its new posts. Fly secrets TG_API_ID,
//     TG_API_HASH (my.telegram.org) and TG_SESSION (scripts/tg-login.js prints it after the login code);
//   - with no session, or when Telegram refuses it, the channel's public page t.me/s/<channel> (the last ~20 posts).
// A bot would not do: a bot sees a channel only when the channel's admin adds it.
//
// Events: a post that names a date not yet past and an event word («презентація», «зустріч з», «запрошуємо»…)
// goes to Haiku, which answers the events in it as fields (or none). A same event already in the calendar (the
// publisher's channel and the bookstore's) is left out (calendar.findSimilar). Off until Max says so (meta
// tg:events = "on"); a dry run over the posts kept shows what it would make (`events({ dry: true })`). At most
// AI_DAY calls a day.
const DAY = 86400000;
const KEEP_DAYS = 90;
const AI_DAY = 60;
const JOINS_PER_RUN = 3; // a new account joining many channels at once looks like spam to Telegram
const MODEL = "claude-haiku-5-5";
const UA = "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua)";
const { parseWhen, kyivDay, addDays } = require("./calendar");

const SCHEMA = `CREATE TABLE IF NOT EXISTS tg_posts (
  channel TEXT NOT NULL, id INTEGER NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]',
  got TEXT NOT NULL, via TEXT NOT NULL DEFAULT '', ev TEXT NOT NULL DEFAULT '', PRIMARY KEY (channel, id)
);
CREATE INDEX IF NOT EXISTS tg_posts_at ON tg_posts (at);`;
// ev: '' not looked at, 'skip' no event words or date, 'none' Haiku found no event, else the event ids, comma-separated.

// web/seed/tgchannels.json: [{ name, note, group?: "club", city?, account?: true }]. A club's channel (from the
// MEGOGO BOOKS club list, Max 2026-11-15) is read from its page every CLUB_HOURS; `account: true` has no public page
// (a closed channel or a group) and waits for our account to join it; `city` helps Haiku when a post names none.
const CLUB_HOURS = 3;
const seed = () => {
  try {
    return require("./seed/tgchannels.json").map((c) => ({ ...c, name: String(c.name).toLowerCase() }));
  } catch {
    return [];
  }
};
const channels = () => seed().map((c) => c.name);

// ---- t.me/s/<channel>: the public page, newest ~20 posts (older with ?before=<id>) ----
const unent = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");
function parsePage(html, channel) {
  const out = [];
  for (const chunk of String(html).split('class="tgme_widget_message_wrap').slice(1)) {
    const id = /data-post="[^"/]+\/(\d+)"/.exec(chunk)?.[1];
    const at = /<time datetime="([^"]+)"/.exec(chunk)?.[1];
    if (!id || !at) continue;
    const body = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] || "";
    const links = [...body.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => unent(unent(m[1]))).filter(outside);
    out.push({ channel, id: +id, at: new Date(at).toISOString(), text: unent(body).trim(), links: [...new Set(links)] });
  }
  return out;
}
// A link worth keeping: not a hashtag, not the channel's own posts.
const outside = (u) => /^https?:\/\//i.test(u) && !/^https?:\/\/t\.me\/(s\/)?[\w]+\/?(\?q=|$)/i.test(u) && !/[?&]q=%23/.test(u);
async function pageOf(channel, before) {
  const r = await fetch(`https://t.me/s/${channel}${before ? `?before=${before}` : ""}`, { headers: { "User-Agent": UA, "Accept-Language": "uk" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error(`t.me/s/${channel}: ${r.status}`);
  return parsePage(await r.text(), channel);
}

// ---- our Telegram account (gramjs) ----
const accountSet = () => !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);
async function connect() {
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const { Logger, LogLevel } = require("telegram/extensions/Logger");
  const client = new TelegramClient(new StringSession(process.env.TG_SESSION), +process.env.TG_API_ID, process.env.TG_API_HASH, {
    connectionRetries: 3,
    floodSleepThreshold: 30,
    baseLogger: new Logger(LogLevel.ERROR),
    deviceModel: "Chytai",
    appVersion: "1.0",
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.destroy().catch(() => {});
    throw new Error("TG_SESSION: not signed in");
  }
  return client;
}
// A message → { text, links } with the links its text carries (plain and under words) and its buttons'.
function fromMessage(m, channel) {
  const text = m.message || "";
  const links = [];
  for (const e of m.entities || []) {
    if (e.className === "MessageEntityTextUrl") links.push(e.url);
    else if (e.className === "MessageEntityUrl") links.push(text.substr(e.offset, e.length));
  }
  for (const row of m.replyMarkup?.rows || []) for (const b of row.buttons || []) if (b.url) links.push(b.url);
  const ok = links.map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)).filter(outside);
  return { channel, id: m.id, at: new Date(m.date * 1000).toISOString(), text, links: [...new Set(ok)] };
}

// ---- the events in a post (Haiku) ----
const EVENT_WORDS = /презентац|зустріч|автограф|відбудеться|відбудуться|запрошуємо|запрошує|чекаємо|вхід вільний|реєстрац|фестивал|лекці|розмов|читанн|книжков\S* клуб|майстер-клас|дискусі|обговор|літгр|вечір/i;
// A post worth asking about: an event word and a date from today on (not more than half a year ahead).
function maybeEvent(text, today = kyivDay()) {
  if (!EVENT_WORDS.test(text || "")) return false;
  const w = parseWhen(text, today);
  return !!w && (w.ends || w.starts) >= today && w.starts <= addDays(today, 183);
}
const SYSTEM = `You read posts from Ukrainian publishers' and bookstores' Telegram channels and pick out book events for a public calendar of book events in Ukraine (and Ukrainian events abroad).

A book event is one people can come to or join online: a book presentation, a meeting or talk with an author, a reading, an autograph session, a book club meeting, a literary lecture or discussion, a literary festival, a book game night. Not an event: a new book, a sale or discount, a contest or giveaway, a grant or call for submissions, a deadline, a funeral, and things unrelated to books (yoga, concerts, economics talks with no book or author behind them, kids' crafts with no book).

Answer every book event in the post that takes place on or after today's date (a post may list several). For each:
- title: short Ukrainian name of the event as a reader would scan it, at most 100 characters, no emoji, e.g. «Презентація роману «Несамовитий» Анни Бурбан», «Зустріч з Віктором Галасюком», «Книжкова мафія за «Батьковбивцею»». Keep book titles in «».
- sub: one plain Ukrainian line, at most 160 characters: what happens and who takes part (moderator, guests). No emoji, no hype.
- starts: YYYY-MM-DD; ends: YYYY-MM-DD for a multi-day event, else "". A date without a year is the nearest one on or after the post's date.
- time: HH:MM (24 h) or "".
- city: the city in Ukrainian, nominative («Київ», «Львів», «Прага»); «Онлайн» if it is only online; "" if the post does not say.
- place: venue and address as the post gives them, at most 120 characters, or "".
- url: the post's link to the event page or registration, only one of the links given; else "".
- books: the books the event is about (presented, discussed, read), each with its title as written, without quotes, and its author's full name in Ukrainian; at most 4, the main ones; [] if no book is named.

When the post has no book event from today on, answer an empty list.`;
const EVENT_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          sub: { type: "string" },
          starts: { type: "string" },
          ends: { type: "string" },
          time: { type: "string" },
          city: { type: "string" },
          place: { type: "string" },
          url: { type: "string" },
          books: { type: "array", items: { type: "object", properties: { title: { type: "string" }, author: { type: "string" } }, required: ["title", "author"], additionalProperties: false } },
        },
        required: ["title", "sub", "starts", "ends", "time", "city", "place", "url", "books"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
  additionalProperties: false,
};

function create(db, { calendar, apiKey = process.env.ANTHROPIC_API_KEY || "", client: ai = null, log = console.log } = {}) {
  db.exec(SCHEMA);
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value || "";
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));
  const anthropic = () => ai || (apiKey ? (ai = new (require("@anthropic-ai/sdk"))({ apiKey })) : null);
  const lastId = (ch) => db.prepare("SELECT max(id) n FROM tg_posts WHERE channel = ?").get(ch)?.n || 0;
  const add = db.prepare("INSERT INTO tg_posts (channel, id, at, text, links, got, via) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, id) DO UPDATE SET text = excluded.text, links = excluded.links");
  const keep = (posts, via) => {
    const now = new Date().toISOString();
    const since = new Date(Date.now() - KEEP_DAYS * DAY).toISOString();
    let n = 0;
    for (const p of posts) if (p.text && p.at >= since) n += add.run(p.channel, p.id, p.at, p.text.slice(0, 6000), JSON.stringify(p.links.slice(0, 10)), now, via).changes;
    return n;
  };

  // Through our account: joins up to JOINS_PER_RUN channels it has not joined, then fetches what is new.
  async function viaAccount(list, out) {
    const { Api } = require("telegram");
    const client = await connect();
    try {
      const dialogs = await client.getDialogs({ limit: 500 });
      const mine = new Map();
      for (const d of dialogs) {
        const u = d.entity?.username?.toLowerCase();
        if (d.isChannel && u) mine.set(u, d);
      }
      // A channel that could not be joined (no such name, a closed one) is not tried again for a week.
      let nojoin = {};
      try {
        nojoin = JSON.parse(meta("tg:nojoin") || "{}");
      } catch {}
      let joins = 0;
      for (const ch of list) {
        if (mine.has(ch) || joins >= JOINS_PER_RUN || Date.now() - Date.parse(nojoin[ch] || 0) < 7 * DAY) continue;
        joins++;
        try {
          await client.invoke(new Api.channels.JoinChannel({ channel: ch }));
          out.joined.push(ch);
        } catch (e) {
          out.errors.push(`join ${ch}: ${e.errorMessage || e.message}`);
          if (/FLOOD/.test(e.errorMessage || "")) joins = JOINS_PER_RUN;
          else nojoin[ch] = new Date().toISOString();
        }
      }
      setMeta("tg:nojoin", JSON.stringify(nojoin));
      // Only joined channels through the account (a name looked up each time would hit Telegram's limits); the
      // others through their pages until their turn to be joined comes.
      await viaPages(list.filter((ch) => !mine.has(ch)), out);
      for (const ch of list) {
        const d = mine.get(ch);
        if (!d) continue;
        const from = lastId(ch);
        if (d.message?.id <= from) continue;
        try {
          const entity = d.entity;
          // A channel seen for the first time: its last 30 days, at most 100 posts.
          const msgs = await client.getMessages(entity, from ? { minId: from, limit: 100 } : { limit: 100 });
          const posts = msgs.filter((m) => m && m.className === "Message" && (from || m.date * 1000 > Date.now() - 30 * DAY)).map((m) => fromMessage(m, ch));
          out.added += keep(posts, "api");
          out.channels[ch] = posts.length;
        } catch (e) {
          out.errors.push(`${ch}: ${e.errorMessage || e.message}`);
        }
      }
    } finally {
      await client.destroy().catch(() => {});
    }
  }
  // Through the public pages: the newest page, and two more back for a channel seen for the first time.
  // A club's channel: its newest page only, every CLUB_HOURS; one with no page waits for the account.
  async function viaPages(list, out) {
    const info = new Map(seed().map((c) => [c.name, c]));
    let read = {};
    try {
      read = JSON.parse(meta("tg:read") || "{}");
    } catch {}
    for (const ch of list) {
      const c = info.get(ch) || {};
      if (c.account) continue;
      if (c.group === "club" && Date.now() - Date.parse(read[ch] || 0) < CLUB_HOURS * 3600000 - 300000) continue;
      try {
        const from = lastId(ch);
        let posts = await pageOf(ch);
        read[ch] = new Date().toISOString();
        for (let i = 0; !from && c.group !== "club" && i < 2 && posts.length; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const older = await pageOf(ch, Math.min(...posts.map((p) => p.id)));
          if (!older.length) break;
          posts = older.concat(posts);
        }
        posts = posts.filter((p) => p.id > from);
        out.added += keep(posts, "page");
        out.channels[ch] = posts.length;
      } catch (e) {
        out.errors.push(`${ch}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setMeta("tg:read", JSON.stringify(read));
  }

  // One run: new posts in, old ones out, then the events in the new ones (when switched on).
  async function run() {
    const list = channels();
    const out = { at: new Date().toISOString(), via: accountSet() ? "api" : "page", added: 0, joined: [], channels: {}, errors: [] };
    db.prepare("DELETE FROM tg_posts WHERE at < ?").run(new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
    if (accountSet()) {
      try {
        await viaAccount(list, out);
      } catch (e) {
        // A session Telegram no longer takes, or a network fault: the public pages this time.
        out.errors.push(`account: ${e.errorMessage || e.message}`);
        out.via = "page";
        await viaPages(list, out);
      }
    } else await viaPages(list, out);
    if (meta("tg:events") === "on") out.events = (await events()).made.length;
    setMeta("tg:last", JSON.stringify({ ...out, errors: out.errors.slice(0, 8) }));
    if (out.errors.length && !out.added && Object.keys(out.channels).length === 0) throw new Error(out.errors[0]);
    return { added: out.added, via: out.via, joined: out.joined.length, events: out.events, errors: out.errors };
  }

  // One post → the events Haiku finds in it; the books each names come as `named` (calendar.upsert looks them up).
  // A page from elsewhere (Chytomo's articles) comes with `page`, its address: the events link there.
  async function ask(p) {
    const c = anthropic();
    if (!c) throw new Error("no ANTHROPIC_API_KEY");
    const links = p.page ? [p.page] : JSON.parse(p.links || "[]");
    const city = p.page ? "" : seed().find((c) => c.name === p.channel)?.city || "";
    const user = `Today: ${kyivDay()}\n${p.page ? `Page: ${p.page}` : `Channel: @${p.channel}${city ? ` (a book club in ${city}; use this city when the post names none and the meeting is not online)` : ""}`}\nPosted: ${p.at.slice(0, 10)}\nLinks in the post: ${links.length ? links.join(" ") : "none"}\n\n${p.text}`;
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: EVENT_SCHEMA } },
    });
    if (res.stop_reason === "refusal") return [];
    const raw = res.content.map((b) => b.text || "").join("");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const today = kyivDay();
    return (j.events || []).filter((e) => /^\d{4}-\d\d-\d\d$/.test(e.starts) && (e.ends || e.starts) >= today && e.title).map(({ books, ...e }) => ({ ...e, named: (books || []).slice(0, 4), url: links.includes(e.url) ? e.url : p.page || `https://t.me/${p.channel}/${p.id}` }));
  }

  // The events in posts not looked at yet (dry: the posts of the last `days` days, nothing kept, at most `max`
  // calls). → { asked, made: [...] }.
  async function events({ dry = false, days = 30, max = AI_DAY } = {}) {
    const today = kyivDay();
    const dayKey = `tg:ai:${today}`;
    const used = dry ? 0 : +meta(dayKey) || 0;
    const posts = db.prepare(`SELECT * FROM tg_posts WHERE ${dry ? "at >= ?" : "ev = '' AND at >= ?"} ORDER BY at`).all(new Date(Date.now() - days * DAY).toISOString());
    const out = { asked: 0, skipped: 0, made: [], dupes: [], errors: [] };
    for (const p of posts) {
      if (!maybeEvent(p.text, today)) {
        out.skipped++;
        if (!dry) db.prepare("UPDATE tg_posts SET ev = 'skip' WHERE channel = ? AND id = ?").run(p.channel, p.id);
        continue;
      }
      if (out.asked + used >= max) break;
      out.asked++;
      let found;
      try {
        found = await ask(p);
      } catch (e) {
        out.errors.push(`${p.channel}/${p.id}: ${e.message}`);
        continue;
      }
      const ids = [];
      found.forEach((e, i) => {
        const ev = { source: "tg", key: `${p.channel}/${p.id}${i ? `-${i}` : ""}`, ...e, post: `https://t.me/${p.channel}/${p.id}` };
        const twin = calendar?.findSimilar({ starts: e.starts, city: e.city, title: e.title });
        if (twin && twin.id !== `tg:${ev.key}`) return out.dupes.push({ ...ev, twin: twin.id });
        if (dry) return out.made.push(ev);
        const id = calendar?.upsert(ev);
        if (id) (ids.push(id), out.made.push(ev));
      });
      if (!dry) db.prepare("UPDATE tg_posts SET ev = ? WHERE channel = ? AND id = ?").run(ids.join(",") || "none", p.channel, p.id);
    }
    if (!dry) setMeta(dayKey, used + out.asked);
    return out;
  }

  function status() {
    const per = db.prepare("SELECT channel, count(*) n, max(at) last, sum(ev NOT IN ('', 'skip', 'none')) events FROM tg_posts GROUP BY channel").all();
    let last = null;
    try {
      last = JSON.parse(meta("tg:last") || "null");
    } catch {}
    return { account: accountSet(), events: meta("tg:events") || "off", channels: channels(), per, last, leads: leads() };
  }

  // Where the events we found come from besides Telegram (Max, 2026-11-15: «звертай увагу, звідки воно… щоб можна
  // підписатись на нього напряму або додати в Sources»): the sites their links lead to, and the channels the event
  // posts link to (t.me/<name>; an @name is mostly a person) that we don't read yet. → { sites: [{ host, n, example }], channels: [{ name, n, from }] }.
  const NOT_A_SOURCE = /(^|\.)(t\.me|forms\.gle|google\.com|goo\.gl|bit\.ly|wayforpay\.com|instagram\.com|facebook\.com|fb\.me|linktr\.ee|youtube\.com|youtu\.be|zoom\.us|tiktok\.com|x\.com|twitter\.com|tally\.so|forms\.cloud\.microsoft|send\.monobank\.ua|privat24\.ua|mono\.bank)$/i;
  function leads() {
    const sites = new Map();
    const mine = new Set(channels());
    const chans = new Map();
    for (const p of db.prepare("SELECT channel, text, links FROM tg_posts WHERE ev NOT IN ('', 'skip', 'none')").all()) {
      for (const u of JSON.parse(p.links || "[]")) {
        let host;
        try {
          host = new URL(u).hostname.replace(/^www\./, "");
        } catch {
          continue;
        }
        if (NOT_A_SOURCE.test(host)) continue;
        const s = sites.get(host) || { host, n: 0, example: u };
        s.n++;
        sites.set(host, s);
      }
      const names = [...`${p.text} ${p.links}`.matchAll(/t\.me\/([a-z][\w]{4,31})(?![\w.])/gi)].map((m) => m[1].toLowerCase());
      for (const n of new Set(names)) {
        if (mine.has(n) || n === "s" || n === "joinchat") continue;
        const c = chans.get(n) || { name: n, n: 0, from: p.channel };
        c.n++;
        chans.set(n, c);
      }
    }
    const top = (m) => [...m.values()].sort((a, b) => b.n - a.n).slice(0, 30);
    return { sites: top(sites), channels: top(chans) };
  }

  // Another site's page → its events, for calendar.chytomoRun.
  const extract = (text, page) => ask({ page, text, at: new Date().toISOString() });
  return { run, events, status, maybeEvent, meta, setMeta, extract };
}

module.exports = { create, parsePage, maybeEvent, fromMessage, channels, KEEP_DAYS };
