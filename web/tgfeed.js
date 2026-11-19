// Posts of public Telegram channels (publishers, bookstores, literary schools), kept 90 days, and the book events
// they announce for «Книжкові події» on /calendar (Max, 2026-11-15: «багато подій є в телеграм»; then «щоб він
// підписався на більшість телеграм каналів і буде сам отримувати свіжі пости. Може там не тільки події згодом
// будуть»). Telegram is only a source here: nothing reader-facing goes through it.
//
// Where the posts come from:
//   - our own Telegram account (not Max's personal one), through Telegram's API for programs (MTProto, the `telegram`
//     package = gramjs). It joins the channels in web/seed/tgchannels.json, a few a run, and each run asks for its
//     dialogs once: a channel whose last post is newer than ours gives its new posts. Fly secrets TG_API_ID,
//     TG_API_HASH (my.telegram.org) and TG_SESSION (web/scripts/tg-login.js prints it after the login code);
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
const AI_DAY = 300; // Max 2026-11-15: «ліміт на haiku можна підняти» (~$0.0002 a call)
const JOINS_PER_RUN = 25; // a call, in the seed's order; Telegram's FLOOD_WAIT sets the real pace (Max 2026-11-15: «так швидко як дозволяє телеграм»).
const MODEL = "claude-haiku-5-5";
const UA = "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua)";
const { parseWhen, kyivDay, addDays, abroad } = require("./calendar");

const SCHEMA = `CREATE TABLE IF NOT EXISTS tg_posts (
  channel TEXT NOT NULL, id INTEGER NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]',
  got TEXT NOT NULL, via TEXT NOT NULL DEFAULT '', ev TEXT NOT NULL DEFAULT '', PRIMARY KEY (channel, id)
);
CREATE INDEX IF NOT EXISTS tg_posts_at ON tg_posts (at);`;
// photo: 1 when the post has a picture (a poster often has the dates, the places and the book the text leaves out;
// Max 2026-11-16, Артур Дронь's tour). ev: '' not looked at, 'skip' no event words or date, 'none' Haiku found no event, else the event ids, comma-separated.

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
    out.push({ channel, id: +id, at: new Date(at).toISOString(), text: unent(body).trim(), links: [...new Set(links)], photo: /tgme_widget_message_photo_wrap/.test(chunk) });
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
  return { channel, id: m.id, at: new Date(m.date * 1000).toISOString(), text, links: [...new Set(ok)], photo: m.media?.className === "MessageMediaPhoto" };
}

// ---- the events in a post (Haiku) ----
const EVENT_WORDS = /презентац|зустріч|автограф|відбудеться|відбудуться|запрошуємо|запрошує|чекаємо|вхід вільний|реєстрац|фестивал|лекці|розмов|читанн|книжков\S* клуб|майстер-клас|дискусі|обговор|літгр|вечір/i;
// A post worth asking about: an event word and a date from today on (not more than half a year ahead).
// A post that cancels or moves a meeting (Max 2026-11-15: «якщо напишуть що скасовується івент треба їх ловити») may
// name no date («завтрашня зустріч не відбудеться»): it goes to Haiku all the same.
const CANCEL_WORDS = /скасов|відмін|не відбудеться|не відбудуться|перенос|перенесен|переносимо/i;
// A day named without a date: «цієї суботи», «у четвер», «завтра» (Max 2026-11-16: «вже цієї суботи зустрічаємо Артура
// Дроня!» was skipped). Haiku gets the post's date and works the day out; only for a post of the last week.
const SOON_WORDS = /(?:^|[^\p{L}])(?:сьогодні|завтра|післязавтра|(?:цього|цієї|цю|у|в|наступного|наступної|наступну|найближчого|найближчої|найближчу)\s+(?:понеділ|вівтор|серед|четвер|п['’ʼ]?ятниц|субот|неділ))/iu;
function maybeEvent(text, today = kyivDay(), posted = "", photo = false) {
  if (!EVENT_WORDS.test(text || "")) return false;
  if (CANCEL_WORDS.test(text)) return true;
  const fresh = !posted || posted.slice(0, 10) >= addDays(today, -7);
  if (SOON_WORDS.test(text) && fresh) return true;
  // A fresh post with a picture: the date may be on the poster only (Haiku sees it, `pictures`).
  if (photo && fresh && posted) return true;
  const w = parseWhen(text, today);
  return !!w && (w.ends || w.starts) >= today && w.starts <= addDays(today, 183);
}
const SYSTEM = `You read posts from Ukrainian publishers' and bookstores' Telegram channels and pick out book events for a public calendar of book events in Ukraine and online.

A book event is one people can come to or join online: a book presentation, a meeting or talk with an author, a reading, an autograph session, a book club meeting, a literary lecture or discussion, a literary festival, a book game night. Not an event: a new book, a sale or discount, a contest or giveaway, a grant or call for submissions, a deadline, a funeral, and things unrelated to books (yoga, concerts, economics talks with no book or author behind them, kids' crafts with no book).

Answer every book event in the post that takes place on or after today's date (a post may list several). For each:
- title: short Ukrainian name of the event as a reader would scan it, at most 100 characters, no emoji, e.g. «Презентація роману «Несамовитий» Анни Бурбан», «Зустріч з Віктором Галасюком», «Книжкова мафія за «Батьковбивцею»». Keep book titles in «».
- sub: one plain Ukrainian line, at most 160 characters: what happens and who takes part (moderator, guests). No emoji, no hype.
- starts: YYYY-MM-DD; ends: YYYY-MM-DD for a multi-day event, else "". A date without a year is the nearest one on or after the post's date.
- time: HH:MM (24 h) or "".
- city: the city in Ukrainian, nominative («Київ», «Львів», «Дрогобич»); «Онлайн» if it is only online; "" if the post does not say.
- abroad: true when it takes place in person outside Ukraine (Warsaw, Prague, Galway…), else false. Online events are never abroad.
- place: venue and address as the post gives them, at most 120 characters, or "".
- url: the post's link to the event page or registration, only one of the links given; else "".
- books: the books the event is about (presented, discussed, read), each with its title as written, without quotes, its author's full name in Ukrainian, and romance: true when it is genre romance (a romcom, romantasy, dark romance, a love story as the whole point, as Colleen Hoover's or Mia Sheridan's), false for anything else (literary fiction with a love story in it, classics, non-fiction); at most 4, the main ones; [] if no book is named.
- kind: what sort of event it is: "club" a book club meeting or a discussion of a book by readers (also book mafia, a joint reading); "author" a presentation, a meeting or talk with the book's author, an autograph session (a presentation of a Ukrainian author's book is "author" unless the text shows the author is not there); a presentation or discussion of a book whose author does not take part (a translated book, a late author's, presented only by a publisher, a translator, a moderator or bloggers) is "club" (Max 2026-11-18); "lecture" a lecture, a course, a talk or panel about literature without one author at its centre; "festival" a festival, a book fair, a multi-event day; "kids" anything made for children; "other" anything else.
- cancelled: true when the post says this event is cancelled or will not take place (скасовано, не відбудеться, відміняється); then starts is the date it was planned for. Else false.
- was: when the post says the event is moved to another day, the day it was planned for before (YYYY-MM-DD), and starts is the new day; "" otherwise (also when only the time or place changes).

The post may come with its pictures. A poster often holds what the text leaves out: the dates, cities and venues, the book's title and author, the publisher. Use them. A tour on a poster (one book or author, many dates and cities) is one event per date and city, each with the same title, kind and books. Decline Ukrainian names correctly («Зустріч з Артуром Дронем»).

A report on an event that has already taken place (відбулася, відбувся, пройшла, дякуємо всім, хто прийшов, фото з зустрічі) is not an event, even when it was today.

When the post has no book event from today on, answer an empty list.`;
const KIND_KEYS = ["club", "author", "lecture", "festival", "kids"];
const KIND_HELP = `"club" a book club meeting or a discussion of a book by readers (also book mafia, a joint reading); "author" a presentation, a meeting or talk with the book's author, an autograph session (a presentation of a Ukrainian author's book is "author" unless the text shows the author is not there); a presentation or discussion of a book whose author does not take part (a translated book, a late author's, presented only by a publisher, a translator, a moderator or bloggers) is "club" (Max 2026-11-18); "lecture" a lecture, a course, a talk or panel about literature without one author at its centre; "festival" a festival, a book fair, a multi-event day; "kids" anything made for children; "other" anything else.`;
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
          abroad: { type: "boolean" },
          place: { type: "string" },
          url: { type: "string" },
          books: { type: "array", items: { type: "object", properties: { title: { type: "string" }, author: { type: "string" }, romance: { type: "boolean" } }, required: ["title", "author", "romance"], additionalProperties: false } },
          kind: { type: "string", enum: ["club", "author", "lecture", "festival", "kids", "other"] },
          cancelled: { type: "boolean" },
          was: { type: "string" },
        },
        required: ["title", "sub", "starts", "ends", "time", "city", "abroad", "place", "url", "books", "kind", "cancelled", "was"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
  additionalProperties: false,
};

// A payment or a call is not the event's page (we sell no tickets): the post is.
const NOT_A_PAGE = /^https?:\/\/([^/]+\.)?(wayforpay\.com|monobank\.ua|mono\.bank|privat24\.ua|meet\.google\.com|zoom\.us)([/:?#]|$)/i;

// The event's link among the post's: the one Haiku named (http/https, «www.», a trailing slash and &amp; don't count),
// but a sign-up form first when the post has exactly one (Max 2026-11-15: the button led to the post, whose only use
// was its link to the form); then one post of another channel (a digest like @knyzhkovi_kluby retells a club's own
// post); else `fallback`, the post itself.
const bare = (u) => String(u || "").replace(/&amp;/g, "&").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
function eventUrl(given, links, fallback, channel = "") {
  const ok = links.filter((u) => !NOT_A_PAGE.test(u));
  const forms = [...new Set(ok.filter((u) => require("./calendar").linkKind(u) === "form"))];
  if (forms.length === 1) return forms[0];
  const hit = given && ok.find((u) => bare(u) === bare(given));
  if (hit) return hit;
  const posts = [...new Set(ok.filter((u) => /^https?:\/\/t\.me\/[a-z]\w{3,31}\/\d+$/i.test(u) && !new RegExp(`^https?://t\\.me/${channel}/`, "i").test(u)))];
  return posts.length === 1 ? posts[0] : fallback;
}

function create(db, { calendar, apiKey = process.env.ANTHROPIC_API_KEY || "", client: ai = null, log = console.log } = {}) {
  db.exec(SCHEMA);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('tg_posts') WHERE name = 'photo'").get()) db.exec("ALTER TABLE tg_posts ADD COLUMN photo INTEGER NOT NULL DEFAULT 0");
  try {
    // Events made before NOT_A_PAGE linked to payments: point them at their post.
    for (const r of db.prepare("SELECT id, url FROM cal_events WHERE source = 'tg'").all())
      if (NOT_A_PAGE.test(r.url)) db.prepare("UPDATE cal_events SET url = ? WHERE id = ?").run(`https://t.me/${r.id.slice(3).replace(/-\d+$/, "")}`, r.id);
  } catch {}
  try {
    // Events that link to their post while the post has one sign-up form: the form (eventUrl, 2026-11-15).
    const post = db.prepare("SELECT links FROM tg_posts WHERE channel = ? AND id = ?");
    for (const r of db.prepare("SELECT id, url FROM cal_events WHERE source = 'tg' AND url LIKE 'https://t.me/%'").all()) {
      const [channel, id] = r.id.slice(3).replace(/-\d+$/, "").split("/");
      const p = post.get(channel, Number(id));
      const url = p ? eventUrl("", JSON.parse(p.links || "[]"), r.url, channel) : r.url;
      if (url !== r.url) db.prepare("UPDATE cal_events SET url = ? WHERE id = ?").run(url, r.id);
    }
  } catch {}
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value || "";
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));
  const jmeta = (k) => {
    try {
      return JSON.parse(meta(k) || "{}") || {};
    } catch {
      return {};
    }
  };
  // The seed's channels but those we left (prune) and groups (Max 2026-11-15: «в групи не додавайся… тільки канали»).
  const live = () => {
    const left = jmeta("tg:left");
    const groups = jmeta("tg:group");
    return [...new Set([...channels(), ...added()])].filter((c) => !left[c] && !groups[c]);
  };
  // Channels discover() found and gave a turn (meta tg:found {name: {at, title, from, members, bookish, added?}}):
  // read, muted and pruned like the seed's.
  const added = () => Object.entries(jmeta("tg:found")).filter(([, f]) => f.added).map(([c]) => c);
  // A group (people's chat) found among the seed's names: never joined; left if joined, its kept posts dropped,
  // a join request withdrawn (LeaveChannel does it, if Telegram lets it).
  const markGroup = (c) => {
    const groups = jmeta("tg:group");
    if (!groups[c]) groups[c] = new Date().toISOString();
    setMeta("tg:group", JSON.stringify(groups));
    db.prepare("DELETE FROM tg_posts WHERE channel = ?").run(c);
  };
  async function dropGroups(client, mine, out) {
    const { Api } = require("telegram");
    const seeded = new Set(channels());
    out.groups = [];
    for (const [c, d] of mine) {
      if (!seeded.has(c) || d.entity?.broadcast) continue;
      try {
        await client.invoke(new Api.channels.LeaveChannel({ channel: d.inputEntity }));
        out.groups.push(c);
      } catch (e) {
        out.errors.push(`leave group ${c}: ${e.errorMessage || e.message}`);
      }
      markGroup(c);
      mine.delete(c);
    }
    // Names that could not be joined (closed, a request sent): a group among them gets its request withdrawn.
    if (meta("tg:groups-checked")) return;
    for (const c of Object.keys(jmeta("tg:nojoin"))) {
      if (!seeded.has(c)) continue;
      try {
        const r = await client.invoke(new Api.contacts.ResolveUsername({ username: c }));
        const chat = r.chats?.[0];
        if (!chat || chat.broadcast) continue;
        await client.invoke(new Api.channels.LeaveChannel({ channel: new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash }) })).then(
          () => out.groups.push(c),
          (e) => out.errors.push(`withdraw ${c}: ${e.errorMessage || e.message}`),
        );
        markGroup(c);
      } catch (e) {
        if (/FLOOD/.test(e.errorMessage || e.message || "")) return;
      }
    }
    setMeta("tg:groups-checked", new Date().toISOString());
  }
  const anthropic = () => ai || (apiKey ? (ai = new (require("@anthropic-ai/sdk"))({ apiKey })) : null);
  const lastId = (ch) => db.prepare("SELECT max(id) n FROM tg_posts WHERE channel = ?").get(ch)?.n || 0;
  const add = db.prepare("INSERT INTO tg_posts (channel, id, at, text, links, got, via, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, id) DO UPDATE SET text = excluded.text, links = excluded.links, photo = max(photo, excluded.photo)");
  const keep = (posts, via) => {
    const now = new Date().toISOString();
    const since = new Date(Date.now() - KEEP_DAYS * DAY).toISOString();
    let n = 0;
    for (const p of posts) if (p.text && p.at >= since) n += add.run(p.channel, p.id, p.at, p.text.slice(0, 6000), JSON.stringify(p.links.slice(0, 10)), now, via, p.photo ? 1 : 0).changes;
    return n;
  };

  // Joins channels of `list` not joined yet, in order, as fast as Telegram lets it (Max 2026-11-15): when it says
  // FLOOD_WAIT, the wait goes into meta tg:flood and nothing is joined till then. A channel that could not be joined
  // (no such name, a closed one) is not tried again for a week (meta tg:nojoin).
  async function joinSome(client, list, mine, out, mute) {
    const { Api } = require("telegram");
    if (Date.now() < Date.parse(meta("tg:flood") || 0)) return;
    let nojoin = {};
    try {
      nojoin = JSON.parse(meta("tg:nojoin") || "{}");
    } catch {}
    // Channels the account was ever in (meta tg:joined; Max 2026-11-15: «щоб не підписуватися знову, якщо я
    // відписався»). One it is no longer in was left by hand: never joined again, and no longer read (tg:left, hand).
    // The first time, all of the list not in nojoin counts: by then every one of them had been joined.
    let joined = jmeta("tg:joined");
    const first = !Object.keys(joined).length;
    const now = new Date().toISOString();
    for (const ch of list) if (mine.has(ch) || (first && !nojoin[ch])) joined[ch] = joined[ch] || now;
    const left = jmeta("tg:left");
    for (const ch of list)
      if (joined[ch] && !mine.has(ch) && !left[ch]) {
        left[ch] = { at: now, hand: true, gone: now };
        (out.unsubscribed ||= []).push(ch);
      }
    setMeta("tg:left", JSON.stringify(left));
    let joins = 0;
    for (const ch of list) {
      if (mine.has(ch) || left[ch] || joins >= JOINS_PER_RUN || Date.now() - Date.parse(nojoin[ch] || 0) < 7 * DAY) continue;
      joins++;
      try {
        // Channels only: a group is never joined (Max 2026-11-15).
        const found = (await client.invoke(new Api.contacts.ResolveUsername({ username: ch }))).chats?.[0];
        if (found && !found.broadcast) {
          markGroup(ch);
          continue;
        }
        const r = await client.invoke(new Api.channels.JoinChannel({ channel: ch }));
        out.joined.push(ch);
        joined[ch] = new Date().toISOString();
        const c = r.chats?.[0];
        if (c) await mute(new Api.InputPeerChannel({ channelId: c.id, accessHash: c.accessHash })).catch((e) => out.errors.push(`mute ${ch}: ${e.errorMessage || e.message}`));
      } catch (e) {
        const msg = e.errorMessage || e.message || "";
        if (/FLOOD/.test(msg)) {
          const wait = +e.seconds || +(msg.match(/\d+/) || [])[0] || 600;
          setMeta("tg:flood", new Date(Date.now() + (wait + 30) * 1000).toISOString());
          out.errors.push(`join: Telegram asks to wait ${wait} s`);
          break;
        }
        out.errors.push(`join ${ch}: ${msg}`);
        nojoin[ch] = new Date().toISOString();
      }
    }
    setMeta("tg:nojoin", JSON.stringify(nojoin));
    setMeta("tg:joined", JSON.stringify(joined));
  }
  // Between the hourly runs: only joins (every 10 minutes, jobs process), when Telegram's wait is over and some
  // channel is left. → { joined, errors }.
  async function joinMore() {
    if (!accountSet() || Date.now() < Date.parse(meta("tg:flood") || 0)) return { joined: [], errors: [] };
    const { Api } = require("telegram");
    const out = { joined: [], errors: [] };
    const client = await connect();
    try {
      const mine = new Map();
      for (const d of await client.getDialogs({ limit: 500 })) {
        const u = d.entity?.username?.toLowerCase();
        if (d.isChannel && u) mine.set(u, d);
      }
      const list = live();
      if (list.every((ch) => mine.has(ch))) return out;
      const mute = (peer) => client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647, silent: true }) }));
      await joinSome(client, list, mine, out, mute);
    } finally {
      await client.destroy().catch(() => {});
    }
    if (out.joined.length) log(`tg: joined ${out.joined.join(", ")}`);
    return out;
  }

  // Through our account: joins what it may (joinSome), then fetches what is new.
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
      // Channels prune() gave up on: the account leaves them.
      const left = jmeta("tg:left");
      for (const [c, x] of Object.entries(left)) {
        const d = mine.get(c);
        if (!d || x.gone) continue;
        try {
          await client.invoke(new Api.channels.LeaveChannel({ channel: d.inputEntity }));
          x.gone = new Date().toISOString();
          mine.delete(c);
        } catch (e) {
          out.errors.push(`leave ${c}: ${e.errorMessage || e.message}`);
        }
      }
      setMeta("tg:left", JSON.stringify(left));
      await dropGroups(client, mine, out);
      const groups = jmeta("tg:group");
      list = list.filter((c) => !groups[c]);
      // Channels someone joined by hand on the account's phone (Max, 2026-11-15) are read and muted too.
      const seeded = new Set(list);
      out.own = [...mine].filter(([u, d]) => !seeded.has(u) && !left[u] && d.entity?.broadcast).map(([u]) => u);
      const all = [...list, ...out.own];
      // Max uses this number himself (2026-11-15): every channel of ours is muted, the moment it is joined.
      const mute = (peer) => client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647, silent: true }) }));
      for (const ch of all) {
        const d = mine.get(ch);
        if (d && !(d.dialog?.notifySettings?.muteUntil > Date.now() / 1000))
          await mute(d.inputEntity).catch((e) => out.errors.push(`mute ${ch}: ${e.errorMessage || e.message}`));
      }
      await joinSome(client, list, mine, out, mute);
      // Only joined channels through the account (a name looked up each time would hit Telegram's limits); the
      // others through their pages until their turn to be joined comes.
      await viaPages(list.filter((ch) => !mine.has(ch)), out);
      for (const ch of all) {
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

  // Channels that give nothing (Max 2026-11-15: «щоб ми могли відписатись і не витрачати на нього токени»), by the
  // last 30 days: 10+ posts sent to Haiku and no event → «quiet», its posts are kept but not sent (a month, then
  // looked at again); a seed channel with 20+ posts of which under 15% speak of books → «left», the account leaves it
  // and it is not read (posts for other uses than events are kept: Max's thread on what else the posts give). Never
  // a channel with `keep: true` in the seed or in meta tg:keep, and never one joined by hand (only quiet).
  // Meta tg:quiet / tg:left {channel: {at, …}}; the technical report names the day's.
  const BOOKISH = /книг|книж|читач|читан|роман|автор|видав|поез|вірш|літератур|бібліот|book|novel|манґ|манга|комікс|прочита/i;
  function prune(out) {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const seeded = seed();
    const inSeed = new Set([...seeded.map((c) => c.name), ...added()]);
    const keep = { ...jmeta("tg:keep"), ...Object.fromEntries(seeded.filter((c) => c.keep).map((c) => [c.name, true])) };
    const quiet = jmeta("tg:quiet");
    const left = jmeta("tg:left");
    // A book club's chat is mostly chatter, yet it is about books: never left (choosenread_bclub, 2026-11-15).
    const club = new Set(seeded.filter((c) => c.group === "club").map((c) => c.name));
    for (const c of Object.keys(left)) if (club.has(c)) delete left[c];
    const now = new Date().toISOString();
    for (const [c, q] of Object.entries(quiet)) if (Date.now() - Date.parse(q.at) > 30 * DAY) delete quiet[c];
    out.quieted = [];
    out.left = [];
    const rows = db.prepare("SELECT channel, count(*) n, sum(ev NOT IN ('', 'skip')) asked, sum(ev NOT IN ('', 'skip', 'none')) made FROM tg_posts WHERE at >= ? GROUP BY channel").all(since);
    for (const r of rows) {
      const c = r.channel;
      if (keep[c] || left[c]) continue;
      if (inSeed.has(c) && !club.has(c) && !r.made && r.n >= 20) {
        const texts = db.prepare("SELECT text FROM tg_posts WHERE channel = ? AND at >= ?").all(c, since);
        const share = texts.filter((t) => BOOKISH.test(t.text)).length / texts.length;
        if (share < 0.15) {
          left[c] = { at: now, posts: r.n, bookish: Math.round(share * 100) };
          out.left.push(c);
          continue;
        }
      }
      if (!quiet[c] && r.asked >= 10 && !r.made) {
        quiet[c] = { at: now, asked: r.asked };
        out.quieted.push(c);
      }
    }
    const skip = db.prepare("UPDATE tg_posts SET ev = 'skip' WHERE channel = ? AND ev = ''");
    for (const c of [...Object.keys(quiet), ...Object.keys(left)]) skip.run(c);
    setMeta("tg:quiet", JSON.stringify(quiet));
    setMeta("tg:left", JSON.stringify(left));
  }
  // Undo for one channel: out of quiet and left, and never pruned again. → true.
  function keepChannel(name) {
    const c = String(name || "").toLowerCase().replace(/^@/, "");
    const quiet = jmeta("tg:quiet"), left = jmeta("tg:left"), keep = jmeta("tg:keep"), joined = jmeta("tg:joined");
    delete quiet[c], delete left[c], delete joined[c], (keep[c] = true);
    setMeta("tg:quiet", JSON.stringify(quiet)), setMeta("tg:left", JSON.stringify(left)), setMeta("tg:keep", JSON.stringify(keep));
    setMeta("tg:joined", JSON.stringify(joined));
    return true;
  }

  // One run: new posts in, old ones out, then the events in the new ones (when switched on).
  async function run() {
    const list = live();
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
    prune(out);
    if (meta("tg:events") === "on") {
      const ev = await events();
      out.events = ev.made.length;
      if (ev.errors.length) out.evErrors = ev.errors.slice(0, 5);
      out.kinds = (await classify()).set;
      if (meta("tg:author-recheck") !== "2") out.authorRecheck = await recheckAuthors();
    }
    setMeta("tg:last", JSON.stringify({ ...out, errors: out.errors.slice(0, 8) }));
    if (out.errors.length && !out.added && Object.keys(out.channels).length === 0) throw new Error(out.errors[0]);
    return { added: out.added, via: out.via, joined: out.joined.length, events: out.events, errors: out.errors };
  }

  // One post → the events Haiku finds in it; the books each names come as `named` (calendar.upsert looks them up).
  // A page from elsewhere (Chytomo's articles) comes with `page`, its address: the events link there.
  // A post's pictures (at most 2) as image blocks for Haiku, from its public embed page (both ways of reading see it;
  // a closed channel has none). Read only for a post Haiku is asked about; nothing is kept. Any failure: no pictures.
  // A page from elsewhere may bring its picture's address (`img`: YouScan's imageUrl, an Instagram poster).
  function imageType(b) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
    if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return "";
  }

  async function pictures(p) {
    if (p.page ? !p.img : !p.photo) return [];
    try {
      let urls = p.img ? [p.img] : [];
      if (!p.page) {
        const r = await fetch(`https://t.me/${p.channel}/${p.id}?embed=1&mode=tme`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        const html = await r.text();
        urls = [...html.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\('(https:\/\/[^']+)'\)/g)].map((m) => m[1]);
      }
      const out = [];
      for (const u of [...new Set(urls)].slice(0, 2)) {
        const img = await fetch(u, { signal: AbortSignal.timeout(8000) });
        if (!img.ok) continue;
        const buf = Buffer.from(await img.arrayBuffer());
        // The bytes say what the picture is: a site's header may lie (rubryka.com's .png are JPEGs, and the API
        // refused the post on every run, 2026-11-18).
        const type = imageType(buf);
        if (!type || buf.length > 4e6) continue;
        out.push({ type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } });
      }
      return out;
    } catch {
      return [];
    }
  }

  async function ask(p) {
    const c = anthropic();
    if (!c) throw new Error("no ANTHROPIC_API_KEY");
    const pics = await pictures(p);
    // A page from elsewhere may bring the links in its text (`more`: a YouScan post's sign-up form).
    const links = p.page ? [...new Set([p.page, ...(p.more || [])])] : JSON.parse(p.links || "[]");
    const city = p.page ? "" : seed().find((c) => c.name === p.channel)?.city || "";
    const user = `Today: ${kyivDay()}\n${p.page ? `Page: ${p.page}` : `Channel: @${p.channel}${city ? ` (a book club in ${city}; use this city when the post names none and the meeting is not online)` : ""}`}\nPosted: ${p.at.slice(0, 10)}\nLinks in the post: ${links.length ? links.join(" ") : "none"}\n\n${p.text}`;
    const res = await c.messages.create({
      model: MODEL,
      // A tour's poster is one event a stop: 22 stops overran 4,000 tokens (2026-11-17).
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: pics.length ? [...pics, { type: "text", text: `${user}\n\n(The post's picture${pics.length > 1 ? "s are" : " is"} above.)` }] : user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: EVENT_SCHEMA } },
    });
    if (res.stop_reason === "refusal") return [];
    if (res.stop_reason === "max_tokens") throw new Error("answer cut at max_tokens");
    const raw = res.content.map((b) => b.text || "").join("");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const today = kyivDay();
    return (j.events || []).filter((e) => /^\d{4}-\d\d-\d\d$/.test(e.starts) && (e.ends || e.starts) >= today && e.title && !e.abroad && !abroad(e.city)).map(({ books, kind, abroad: _a, ...e }) => ({ ...e, kind: kind === "other" ? "" : kind || "", named: (books || []).slice(0, 4), url: eventUrl(e.url, links, p.page || `https://t.me/${p.channel}/${p.id}`, p.page ? "" : p.channel) }));
  }

  // The events in posts not looked at yet (dry: the posts of the last `days` days, nothing kept, at most `max`
  // calls). → { asked, made: [...] }.
  async function events({ dry = false, days = 30, max = AI_DAY } = {}) {
    const today = kyivDay();
    const dayKey = `tg:ai:${today}`;
    const used = dry ? 0 : +meta(dayKey) || 0;
    const posts = db.prepare(`SELECT * FROM tg_posts WHERE ${dry ? "at >= ?" : "ev = '' AND at >= ?"} ORDER BY at`).all(new Date(Date.now() - days * DAY).toISOString());
    const out = { asked: 0, skipped: 0, made: [], dupes: [], cancelled: [], errors: [] };
    // Once: the last week's posts skipped before «цієї суботи» counted get another look (2026-11-16).
    // Once: the last week's posts that made events are asked again with their pictures (2026-11-17).
    if (!dry && !meta("tg:photo-recheck")) {
      const since = new Date(Date.now() - 7 * DAY).toISOString();
      const again = db.prepare("SELECT * FROM tg_posts WHERE ev LIKE 'tg:%' AND at >= ?").all(since);
      for (const p of again) db.prepare("UPDATE tg_posts SET ev = '', photo = 1 WHERE channel = ? AND id = ?").run(p.channel, p.id);
      posts.push(...again.filter((p) => !posts.some((x) => x.channel === p.channel && x.id === p.id)).map((p) => ({ ...p, ev: "", photo: 1 })));
      setMeta("tg:photo-recheck", String(again.length));
    }
    if (!dry && !meta("tg:soon-recheck")) {
      const since = new Date(Date.now() - 7 * DAY).toISOString();
      const again = db.prepare("SELECT * FROM tg_posts WHERE ev = 'skip' AND at >= ?").all(since).filter((p) => maybeEvent(p.text, today, p.at, !!p.photo));
      for (const p of again) db.prepare("UPDATE tg_posts SET ev = '' WHERE channel = ? AND id = ?").run(p.channel, p.id);
      if (again.length) posts.push(...again.filter((p) => !posts.some((x) => x.channel === p.channel && x.id === p.id)));
      setMeta("tg:soon-recheck", String(again.length));
    }
    for (const p of posts) {
      if (!maybeEvent(p.text, today, p.at, !!p.photo)) {
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
        // Cancelled: the event we have for that day is taken off. Moved: the old day's one goes, the new day's comes.
        if (e.cancelled || /^\d{4}-\d\d-\d\d$/.test(e.was || "")) {
          const old = calendar?.findSimilar({ starts: e.cancelled ? e.starts : e.was, city: e.city, title: e.title });
          if (old && old.id !== `tg:${p.channel}/${p.id}${i ? `-${i}` : ""}`) {
            if (!dry) calendar?.cancel?.(old.id, e.cancelled ? "cancelled" : `moved:${e.starts}`, `https://t.me/${p.channel}/${p.id}`);
            out.cancelled.push({ id: old.id, title: old.title, how: e.cancelled ? "скасовано" : `перенесено на ${e.starts}` });
          }
          if (e.cancelled) return;
        }
        const ev = { source: "tg", key: `${p.channel}/${p.id}${i ? `-${i}` : ""}`, ...e, post: `https://t.me/${p.channel}/${p.id}` };
        const twin = calendar?.findSimilar({ starts: e.starts, city: e.city, title: e.title });
        if (twin && twin.id !== `tg:${ev.key}`) {
          if (!dry && e.kind) calendar?.setKinds?.({ [twin.id]: e.kind });
          return out.dupes.push({ ...ev, twin: twin.id });
        }
        if (dry) return out.made.push(ev);
        const id = calendar?.upsert(ev);
        if (id) (ids.push(id), out.made.push(ev));
      });
      if (!dry) db.prepare("UPDATE tg_posts SET ev = ? WHERE channel = ? AND id = ?").run(ids.join(",") || "none", p.channel, p.id);
    }
    if (!dry) setMeta(dayKey, used + out.asked);
    return out;
  }

  // Kinds for upcoming events that have none (made before kinds, added by readers, festivals from the seed, Є):
  // 25 to a Haiku call, counted with the posts' calls. One Haiku called «other» is not asked again (meta tg:other).
  // Once (Max 2026-11-18: «якщо автора немає на зустрічі то це книжковий клуб»): upcoming «author» events sorted
  // again by the rule above; one whose author is not there becomes a club. Meta `tg:author-recheck` = done.
  async function recheckAuthors() {
    const c = anthropic();
    if (!c) return { asked: 0, set: 0 };
    const today = kyivDay();
    // The first pass (meta «1») took «презентація книги» with no word of the author for a club: the events it moved go
    // through again with the rule that says when (2026-11-18).
    let moved = [];
    try {
      moved = meta("tg:author-recheck") === "1" ? JSON.parse(meta("tg:author-recheck-log") || "[]").map((l) => l.replace(/ → \w+$/, "")) : [];
    } catch {}
    const rows = db
      .prepare("SELECT id, title, sub, place, kind FROM cal_events WHERE hidden = 0 AND (starts >= ? OR ends >= ?) ORDER BY starts")
      .all(today, today)
      .filter((r) => (moved.length ? moved.includes(r.title) && r.kind !== "author" : r.kind === "author"))
      .slice(0, 300);
    const out = { asked: 0, set: 0, changed: [] };
    const up = db.prepare("UPDATE cal_events SET kind = ? WHERE id = ? AND kind = ?");
    for (let i = 0; i < rows.length; i += 25) {
      const batch = rows.slice(i, i + 25);
      out.asked++;
      try {
        const res = await c.messages.create({
          model: MODEL,
          max_tokens: 2000,
          system: `You sort Ukrainian book events for a calendar. For each event answer its kind: ${KIND_HELP}`,
          messages: [{ role: "user", content: batch.map((r, n) => `${n + 1}. ${r.title} — ${r.sub} ${r.place ? `(${r.place})` : ""}`).join("\n") }],
          output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: { kinds: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, kind: { type: "string", enum: [...KIND_KEYS, "other"] } }, required: ["n", "kind"], additionalProperties: false } } }, required: ["kinds"], additionalProperties: false } } },
        });
        const raw = res.content.map((b) => b.text || "").join("");
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
        for (const k of j.kinds || []) {
          const r = batch[k.n - 1];
          if (!r || k.kind === r.kind || !KIND_KEYS.includes(k.kind)) continue;
          if (up.run(k.kind, r.id, r.kind).changes) (out.set++, out.changed.push(`${r.title} → ${k.kind}`));
        }
      } catch (e) {
        log(`tg recheck: ${e.message}`);
        return out; // not marked done: the next run tries again
      }
    }
    setMeta("tg:author-recheck", "2");
    if (out.set) calendar?.fresh?.();
    setMeta("tg:author-recheck-log", JSON.stringify([...(moved.length ? JSON.parse(meta("tg:author-recheck-log") || "[]") : []), ...out.changed].slice(0, 200)));
    return out;
  }

  async function classify({ max = AI_DAY } = {}) {
    const c = anthropic();
    if (!c || !calendar?.setKinds) return { asked: 0, set: 0 };
    const today = kyivDay();
    const dayKey = `tg:ai:${today}`;
    let used = +meta(dayKey) || 0;
    let other = [];
    try {
      other = JSON.parse(meta("tg:other") || "[]");
    } catch {}
    const rows = db
      .prepare("SELECT id, title, sub, place FROM cal_events WHERE kind = '' AND hidden = 0 AND (starts >= ? OR ends >= ?) ORDER BY starts LIMIT 500")
      .all(today, today)
      .filter((r) => !other.includes(r.id));
    const out = { asked: 0, set: 0 };
    for (let i = 0; i < rows.length && used < max; i += 25) {
      const batch = rows.slice(i, i + 25);
      used++, out.asked++;
      try {
        const res = await c.messages.create({
          model: MODEL,
          max_tokens: 2000,
          system: `You sort Ukrainian book events for a calendar. For each event answer its kind: ${KIND_HELP}`,
          messages: [{ role: "user", content: batch.map((r, n) => `${n + 1}. ${r.title} — ${r.sub} ${r.place ? `(${r.place})` : ""}`).join("\n") }],
          output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: { kinds: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, kind: { type: "string", enum: [...KIND_KEYS, "other"] } }, required: ["n", "kind"], additionalProperties: false } } }, required: ["kinds"], additionalProperties: false } } },
        });
        const raw = res.content.map((b) => b.text || "").join("");
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
        const set = {};
        for (const k of j.kinds || []) {
          const r = batch[k.n - 1];
          if (!r) continue;
          if (k.kind === "other") other.push(r.id);
          else set[r.id] = k.kind;
        }
        out.set += calendar.setKinds(set);
      } catch (e) {
        log(`tg classify: ${e.message}`);
      }
    }
    setMeta(dayKey, used);
    const live = new Set(db.prepare("SELECT id FROM cal_events WHERE starts >= ? OR ends >= ?").all(today, today).map((r) => r.id));
    setMeta("tg:other", JSON.stringify(other.filter((id) => live.has(id))));
    return out;
  }

  function status() {
    const per = db.prepare("SELECT channel, count(*) n, max(at) last, sum(ev NOT IN ('', 'skip', 'none')) events FROM tg_posts GROUP BY channel").all();
    let last = null;
    try {
      last = JSON.parse(meta("tg:last") || "null");
    } catch {}
    return { account: accountSet(), events: meta("tg:events") || "off", flood: meta("tg:flood") || null, channels: live(), quiet: jmeta("tg:quiet"), left: jmeta("tg:left"), groups: jmeta("tg:group"), per, last, leads: leads() };
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

  // New book channels (Max 2026-11-16: «чи ми робимо діскавері нових книжкових каналів?»): Telegram's «Similar
  // Channels» for each channel the account is in (channels.getChannelRecommendations; Premium gives more), counted:
  // a channel that several of ours point to is most likely about books. Then each such candidate's last ~20 posts
  // (its public page, else the API): Ukrainian (і/ї/є/ґ against ы/э/ъ/ё), about books (BOOKISH in DISCOVER_BOOKISH of
  // its posts), alive (a post in the last 30 days), a channel and not a group, not one we read, left or gave up on.
  // Those that pass wait in meta tg:found; promote() gives DISCOVER_DAY of them a day to the joins (Max 2026-11-16:
  // «Сам, до 10 на день»). Once a week (discoverWeekly); dry = only the list (meta tg:discover). → { at, asked, candidates }.
  const DISCOVER_MIN = 2; // our channels that point to it
  const DISCOVER_BOOKISH = 0.3;
  const DISCOVER_CHECK = 80; // candidates whose posts are read, the most pointed-to first
  const DISCOVER_DAY = 10;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const ukShare = (texts) => {
    const all = texts.join(" ");
    const uk = (all.match(/[іїєґ]/gi) || []).length, ru = (all.match(/[ыэъё]/gi) || []).length;
    return { uk, ru, ok: uk >= 20 && uk >= 3 * ru };
  };
  async function discover({ dry = false } = {}) {
    if (!accountSet()) return { error: "no account" };
    const { Api } = require("telegram");
    const out = { at: new Date().toISOString(), asked: 0, errors: [], candidates: [] };
    const client = await connect();
    try {
      const mine = new Map();
      for (const d of await client.getDialogs({ limit: 500 })) {
        const u = d.entity?.username?.toLowerCase();
        if (d.isChannel && u) mine.set(u, d);
      }
      const skip = new Set([...mine.keys(), ...channels(), ...Object.keys(jmeta("tg:left")), ...Object.keys(jmeta("tg:group")), ...Object.keys(jmeta("tg:joined")), ...Object.keys(jmeta("tg:found"))]);
      const found = new Map();
      const note = (chats, from) => {
        for (const c of chats || []) {
          const u = c.username?.toLowerCase();
          if (!u || skip.has(u)) continue;
          const f = found.get(u) || { name: c.username, title: c.title, members: c.participantsCount ?? null, broadcast: !!c.broadcast, peer: c, from: [] };
          if (!f.from.includes(from)) f.from.push(from);
          found.set(u, f);
        }
      };
      // The account's own «you may like» (from all its channels), then each channel's similar ones.
      try {
        note((await client.invoke(new Api.channels.GetChannelRecommendations({}))).chats, "*");
        out.asked++;
      } catch (e) {
        out.errors.push(`recommendations: ${e.errorMessage || e.message}`);
      }
      for (const [u, d] of mine) {
        if (!d.entity?.broadcast) continue;
        try {
          note((await client.invoke(new Api.channels.GetChannelRecommendations({ channel: d.inputEntity }))).chats, u);
          out.asked++;
        } catch (e) {
          const msg = e.errorMessage || e.message || "";
          out.errors.push(`${u}: ${msg}`);
          if (/FLOOD/.test(msg)) break;
        }
        await pause(700);
      }
      out.found = found.size;
      const list = [...found.values()].filter((f) => f.from.length >= DISCOVER_MIN || f.from.includes("*")).sort((a, b) => b.from.length - a.from.length || (b.members || 0) - (a.members || 0)).slice(0, DISCOVER_CHECK);
      for (const f of list) {
        let posts = [];
        try {
          posts = await pageOf(f.name.toLowerCase());
        } catch {}
        if (!posts.length && f.broadcast) {
          try {
            posts = (await client.getMessages(new Api.InputPeerChannel({ channelId: f.peer.id, accessHash: f.peer.accessHash }), { limit: 20 })).filter((m) => m?.className === "Message").map((m) => fromMessage(m, f.name));
          } catch (e) {
            out.errors.push(`${f.name}: ${e.errorMessage || e.message}`);
          }
          await pause(700);
        }
        const texts = posts.map((p) => p.text).filter(Boolean);
        const lang = ukShare([f.title, ...texts]);
        const bookish = texts.length ? texts.filter((t) => BOOKISH.test(t)).length / texts.length : 0;
        const last = posts.map((p) => p.at).sort().pop() || null;
        const why = [];
        if (!f.broadcast) why.push("група");
        if (!lang.ok) why.push(lang.uk || lang.ru ? `мова (і/ї/є ${lang.uk}, ы/э/ъ ${lang.ru})` : "мова не видно");
        if (!texts.length) why.push("постів не видно");
        else if (bookish < (BOOKISH.test(f.title) ? 0.15 : DISCOVER_BOOKISH)) why.push(`про книжки ${Math.round(bookish * 100)}%`);
        if (last && Date.now() - Date.parse(last) > 30 * DAY) why.push(`останній пост ${last.slice(0, 10)}`);
        out.candidates.push({ name: f.name, title: f.title, members: f.members, from: f.from.length, by: f.from.slice(0, 5), bookish: Math.round(bookish * 100), last: last?.slice(0, 10) || null, ok: !why.length, why });
      }
    } finally {
      await client.destroy().catch(() => {});
    }
    out.candidates.sort((a, b) => b.ok - a.ok || b.from - a.from || (b.members || 0) - (a.members || 0));
    out.errors = out.errors.slice(0, 10);
    setMeta("tg:discover", JSON.stringify(out));
    if (!dry) {
      const found = jmeta("tg:found");
      for (const c of out.candidates) if (c.ok) found[c.name.toLowerCase()] ||= { at: out.at, title: c.title, from: c.from, members: c.members, bookish: c.bookish };
      setMeta("tg:found", JSON.stringify(found));
      setMeta("tg:discover-run", out.at);
      promote();
    }
    return out;
  }
  // Up to DISCOVER_DAY waiting channels a Kyiv day get their turn, the most pointed-to first. → names.
  function promote() {
    const found = jmeta("tg:found");
    const today = kyivDay();
    const room = DISCOVER_DAY - Object.values(found).filter((f) => f.added && kyivDay(new Date(f.added)) === today).length;
    const next = Object.entries(found).filter(([, f]) => !f.added).sort((a, b) => b[1].from - a[1].from).slice(0, Math.max(0, room));
    for (const [, f] of next) f.added = new Date().toISOString();
    if (next.length) setMeta("tg:found", JSON.stringify(found));
    return next.map(([c]) => c);
  }
  // The jobs process, daily: a new search once a week, and the day's turn for those waiting.
  async function discoverWeekly() {
    if (!accountSet()) return { skipped: "no account" };
    if (Date.now() - Date.parse(meta("tg:discover-run") || 0) > 7 * DAY) {
      const r = await discover();
      return { asked: r.asked, found: r.found, ok: r.candidates?.filter((c) => c.ok).length, added: added().length };
    }
    return { promoted: promote() };
  }

  // Another site's page → its events, for calendar.chytomoRun.
  // A page from elsewhere (Chytomo, Eventmate, YouScan's mentions): its cancelled events are left out, nothing else is
  // matched. `at`: when it was posted (Haiku dates «цієї суботи» from it); `img`: its picture's address.
  const extract = (text, page, { at, img, links } = {}) => ask({ page, text, img, more: links, at: at || new Date().toISOString() }).then((list) => list.filter((e) => !e.cancelled));
  // Public channels whose title has these words, as the account sees them (to find a channel's @name for the seed).
  async function find(q) {
    if (!accountSet()) return { error: "no account" };
    const { Api } = require("telegram");
    const client = await connect();
    try {
      const r = await client.invoke(new Api.contacts.Search({ q: String(q).slice(0, 64), limit: 10 }));
      return { found: (r.chats || []).filter((c) => c.username && c.broadcast).map((c) => ({ name: c.username, title: c.title, members: c.participantsCount ?? null })) };
    } finally {
      await client.destroy().catch(() => {});
    }
  }

  // A voice message Max sent the bot (bugbox.js) → its words. A bot can't transcribe and the Claude API takes no audio,
  // so the account (Premium) does it: the file goes to its own Saved Messages as a voice note, Telegram's
  // messages.transcribeAudio reads it, and the message is deleted again. → { text } or { error }.
  async function transcribe(file, duration = 0) {
    if (!accountSet()) return { error: "no account" };
    const { Api } = require("telegram");
    const { CustomFile } = require("telegram/client/uploads");
    const buf = require("fs").readFileSync(file);
    const client = await connect();
    let sent = null;
    try {
      sent = await client.sendFile("me", {
        file: new CustomFile("voice.ogg", buf.length, "", buf),
        voiceNote: true,
        attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: Math.max(1, Math.round(+duration || 1)) })],
        silent: true,
      });
      const ask = () => client.invoke(new Api.messages.TranscribeAudio({ peer: "me", msgId: sent.id }));
      let r = await ask();
      // Pending: Telegram sends updateTranscribedAudio when done; asking again gives the same answer, so we ask.
      for (let i = 0; r.pending && i < 40; i++) {
        await new Promise((ok) => setTimeout(ok, 1500));
        r = await ask();
      }
      if (r.pending) return { error: "Telegram не дорозшифрував за хвилину" };
      return { text: String(r.text || "").trim() };
    } catch (e) {
      return { error: e.errorMessage || e.message };
    } finally {
      if (sent) await client.deleteMessages("me", [sent.id], { revoke: true }).catch(() => {});
      await client.destroy().catch(() => {});
    }
  }

  return { run, joinMore, joinSome, keepChannel, prune, dropGroups, discover, discoverWeekly, promote, events, classify, recheckAuthors, status, maybeEvent, meta, setMeta, extract, find, transcribe };
}

module.exports = { eventUrl, create, parsePage, maybeEvent, fromMessage, channels, KEEP_DAYS };
