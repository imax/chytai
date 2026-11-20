// YouScan (youscan.io, social listening; Max's trial 2026-11-17, «давай почнемо з подій»): book events from posts
// on Instagram, Facebook, Telegram chats, forums and news that its topics find. YouScan posts each mention to our
// address (a topic's Settings → Integrations → Webhook, sent by its Rules); the API is a paid add-on we don't need.
//
// The web process keeps each mention (table ys_mentions, 30 days) and answers at once; the jobs process, every
// 15 min, sends the ones with an event word and a date (tgfeed `maybeEvent`) through the Telegram collector's Haiku
// (`tgFeed.extract`, with the post's picture), AI_DAY calls a day. Events come in as source `ys`, linked to the post
// (its one sign-up form when the post has one; an Instagram or Facebook post shows as «соцмережі»; a Telegram one as its channel, never the post). A post from a
// channel the Telegram collector reads already is left to it; the same event told elsewhere (findSimilar) is left out.
const DAY = 86400000;
const KEEP_DAYS = 30;
const AI_DAY = 300; // Max 2026-11-18: 60 ran out by 9 a.m.
const TAKE_DAY = 3000; // mentions kept a day at most (a topic too wide would flood the table)
const { kyivDay } = require("./calendar");
const { maybeEvent, eventUrl } = require("./tgfeed");
// The addresses in a post's text (a sign-up form is the event's link, not the post).
const linksIn = (t) => [...new Set((String(t || "").match(/https?:\/\/[^\s<>"«»()]+/g) || []).map((u) => u.replace(/[.,;:!?…]+$/, "")))].slice(0, 20);

const SCHEMA = `CREATE TABLE IF NOT EXISTS ys_mentions (
  id TEXT PRIMARY KEY, topic TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, img TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, got TEXT NOT NULL,
  ev TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ys_mentions_got ON ys_mentions (got);`;
// ev: '' not looked at, 'skip' no event words or date / not Ukrainian, 'tg' a channel the Telegram collector reads,
// 'none' Haiku found no event, 'fail' the API refused the request (not asked again), else the event ids, comma-separated.

const str = (v, n) => String(v ?? "").slice(0, n);
// YouScan marks the words its query matched with <b>…</b> in title and text: plain text for us.
const plain = (t) =>
  String(t || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]{0,40}>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
// A picture's address we may fetch: https on a named host (no IPs, no local names).
const okImg = (u) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/|$)/i.test(u || "") && !/^https:\/\/[^/]*localhost/i.test(u) ? u : "";
// The mentions in a webhook's body: one mention, a list, or a list under a key.
function mentionsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const k of ["mentions", "items", "data"]) if (Array.isArray(body[k])) return body[k];
  return [body];
}

function create(db, { calendar, extract = null, log = console.log } = {}) {
  db.exec(SCHEMA);
  try {
    // Events made before the post's links were looked at (2026-11-17): its one sign-up form, not the post.
    const post = db.prepare("SELECT url, text FROM ys_mentions WHERE id = ?");
    for (const r of db.prepare("SELECT id, url FROM cal_events WHERE source = 'ys'").all()) {
      const m = post.get(r.id.slice(3).replace(/-\d+$/, ""));
      if (!m || m.url !== r.url) continue;
      const url = eventUrl("", linksIn(plain(m.text)), r.url);
      if (url !== r.url) db.prepare("UPDATE cal_events SET url = ? WHERE id = ?").run(url, r.id);
    }
  } catch {}
  const meta = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value || "";
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));

  // The webhook's body → how many mentions were kept (a repeat of the same mention is kept once).
  function take(body) {
    const list = mentionsOf(body);
    const day = kyivDay();
    const key = `youscan:in:${day}`;
    let n = +meta(key) || 0;
    const ins = db.prepare("INSERT OR IGNORE INTO ys_mentions (id, topic, source, url, author, text, img, at, got) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let kept = 0;
    const now = new Date().toISOString();
    for (const m of list.slice(0, 500)) {
      if (!m || typeof m !== "object" || m.spam === true) continue;
      const id = str(m.mentionId ?? m.id ?? m.postId, 80);
      const text = [m.title, m.text].filter((t) => t && typeof t === "string").map(plain).join("\n\n").slice(0, 6000);
      if (!id || !text.trim()) continue;
      if (n >= TAKE_DAY) break;
      const at = Date.parse(m.published) ? new Date(m.published).toISOString() : now;
      const author = str(m.channel?.name || m.author?.name || m.author?.nickname || "", 120);
      const r = ins.run(id, str(m.topicName, 120), str(m.sourceName || m.resourceType, 60), str(/^https?:\/\//i.test(m.url || "") ? m.url : "", 500), author, text, okImg(m.imageUrl), at, now);
      if (r.changes) (kept++, n++);
    }
    setMeta(key, n);
    setMeta("youscan:last-in", JSON.stringify({ at: now, got: list.length, kept }));
    return kept;
  }

  // The jobs process: the mentions not looked at yet → events. dry: the last `days` days' mentions again, nothing kept.
  async function run({ dry = false, days = 7, max = AI_DAY } = {}) {
    const today = kyivDay();
    const dayKey = `youscan:ai:${today}`;
    const used = dry ? 0 : +meta(dayKey) || 0;
    const out = { at: new Date().toISOString(), dry, looked: 0, skipped: 0, telegram: 0, asked: 0, made: [], dupes: [], errors: [] };
    if (!extract) return out;
    const rows = db.prepare(`SELECT * FROM ys_mentions WHERE ${dry ? "got >= ?" : "ev = '' AND got >= ?"} ORDER BY got`).all(new Date(Date.now() - days * DAY).toISOString());
    const mark = (id, ev) => !dry && db.prepare("UPDATE ys_mentions SET ev = ? WHERE id = ?").run(ev, id);
    // Channels the Telegram collector reads (their posts are kept there).
    let ours = new Set();
    try {
      ours = new Set(db.prepare("SELECT DISTINCT lower(channel) AS c FROM tg_posts").all().map((r) => r.c));
    } catch {}
    for (const m of rows) {
      out.looked++;
      m.text = plain(m.text); // rows kept before the tags were taken out (2026-11-17)
      const ch = /^https?:\/\/(?:t|telegram)\.me\/([a-z]\w{3,31})\/\d+/i.exec(m.url)?.[1]?.toLowerCase();
      if (ch && ours.has(ch)) {
        out.telegram++;
        mark(m.id, "tg");
        continue;
      }
      // Ukrainian only (a Russian post has none of і ї є ґ).
      if (!/[іїєґ]/i.test(m.text) || !maybeEvent(m.text, today, m.at, !!m.img)) {
        out.skipped++;
        mark(m.id, "skip");
        continue;
      }
      if (out.asked + used >= max) break;
      out.asked++;
      let found;
      try {
        const head = [m.source && `Джерело: ${m.source}`, m.author && `Автор: ${m.author}`].filter(Boolean).join("\n");
        found = await extract(`${head ? `${head}\n\n` : ""}${m.text}`, m.url || "https://youscan.io", { at: m.at, img: m.img, links: linksIn(m.text) });
      } catch (e) {
        out.errors.push(`${m.id}: ${e.message}`);
        // The API refused this very request (400): asking again every 15 min only spends the day's calls (2026-11-18:
        // two posts took ~190 of 300). A network fault, 429 or 5xx is tried again on the next run.
        if (e.status >= 400 && e.status < 500 && e.status !== 429) mark(m.id, "fail");
        continue;
      }
      const ids = [];
      found.forEach((e, i) => {
        const ev = { source: "ys", key: `${m.id}${i ? `-${i}` : ""}`, ...e, url: e.url === "https://youscan.io" ? "" : e.url };
        const twin = calendar.findSimilar({ starts: e.starts, city: e.city, title: e.title, time: e.time });
        if (twin && twin.id !== `ys:${ev.key}`) return out.dupes.push({ title: e.title, twin: twin.id });
        if (dry) return out.made.push({ title: e.title, starts: e.starts, city: e.city, url: ev.url });
        const id = calendar.upsert(ev);
        if (id) (ids.push(id), out.made.push({ title: e.title, starts: e.starts, city: e.city, url: ev.url }));
      });
      mark(m.id, ids.join(",") || "none");
    }
    if (!dry) {
      setMeta(dayKey, used + out.asked);
      db.prepare("DELETE FROM ys_mentions WHERE got < ?").run(new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
      setMeta("youscan:last", JSON.stringify({ ...out, made: out.made.length, dupes: out.dupes.length, errors: out.errors.slice(0, 5) }));
    }
    if (out.made.length && !dry) log(`youscan: ${out.made.length} events`);
    return out;
  }

  // What came in and what it made (for /agent/youscan).
  function status() {
    const j = (k) => {
      try {
        return JSON.parse(meta(k) || "null");
      } catch {
        return null;
      }
    };
    const by = db.prepare("SELECT CASE WHEN ev IN ('', 'skip', 'tg', 'none', 'fail') THEN ev ELSE 'event' END AS ev, count(*) AS n FROM ys_mentions GROUP BY 1").all();
    const topics = db.prepare("SELECT topic, source, count(*) AS n FROM ys_mentions GROUP BY 1, 2 ORDER BY n DESC LIMIT 20").all();
    const recent = db.prepare("SELECT id, topic, source, url, author, substr(text, 1, 200) AS text, at, ev FROM ys_mentions ORDER BY got DESC LIMIT 10").all();
    return { lastIn: j("youscan:last-in"), last: j("youscan:last"), today: { in: +meta(`youscan:in:${kyivDay()}`) || 0, ai: +meta(`youscan:ai:${kyivDay()}`) || 0 }, by, topics, recent };
  }

  return { take, run, status };
}

module.exports = { create, mentionsOf, plain };
