// Fresh Threads posts that ask for a book to read, for Max to look at on /admin/threads and answer himself
// (Max, 2026-11-12: «просто зробимо пошук … свіжі треди, де питають порадити книжку, і сам на них дивитися
// очима, а комусь відповідати, комусь ні»). Nothing is posted to Threads from here, no AI is called.
//
// Where the posts come from: Threads' own keyword search sees other people's posts only after Meta's App Review,
// so a source is whichever key is set: THREADS_TOKEN (Meta's API, after App Review) or SOCIALFETCH_KEY
// (socialfetch.dev, a paid search, 1 credit per query). The jobs process searches every few hours; a post is kept
// when it is Ukrainian and asks for a book (`wanted()`), at most 30 days, then it goes.
const DAY = 86400 * 1000;
const KEEP_DAYS = 30;
// Phrases people use to ask; each is one query (one credit on SocialFetch) per run.
const QUERIES = ["порадьте книжку", "порадьте книгу", "що почитати", "шукаю книжку", "підкажіть книжку", "книжку по вайбу"];

const SCHEMA = `CREATE TABLE IF NOT EXISTS threads_finds (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, posted TEXT NOT NULL,
  found TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', replies INTEGER, state TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS threads_finds_posted ON threads_finds (posted);`;

// Ukrainian, not Russian: a Russian letter (ы э ъ ё) or word drops it; a Ukrainian letter (і ї є ґ) or word is needed
// («Порадьте книжку?» has no Ukrainian letter).
// A request: «порад…», «підкаж…», «шукаю», «що почитати», «допоможіть» or a question mark, next to a book word.
function wanted(text) {
  const t = String(text || "").toLowerCase();
  if (/[ыэъё]/.test(t) || /(^|[^а-яіїєґ])(что|посоветуй\S*|какую|какой|почитать)(?![а-яіїєґ])/.test(t)) return false;
  if (!/[іїєґ]/.test(t) && !/порад|книжк|почитати|підкаж/.test(t)) return false;
  const book = /книж|книг|почитати|прочитати|роман|автор|серії|серію|фентез|детектив|антиутоп|трилер|класик/.test(t);
  const ask = /порад|підкаж|посовет|шукаю|що почитати|що б почитати|що ще почитати|допоможіть|поможіть|рекоменд|\?/.test(t);
  return book && ask;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${new URL(url).host}: ${j.error?.message || j.message || j.error || r.status}`);
  return j;
}

// One query → [{ id, url, author, text, posted, replies }] from whichever source has a key.
const sources = {
  meta: {
    on: () => !!process.env.THREADS_TOKEN,
    async search(q, since) {
      const p = new URLSearchParams({ q, search_type: "RECENT", since: String(Math.floor(since / 1000)), limit: "100", fields: "id,text,permalink,timestamp,username,is_reply", access_token: process.env.THREADS_TOKEN });
      const j = await getJson(`https://graph.threads.net/v1.0/keyword_search?${p}`);
      return (j.data || []).filter((x) => !x.is_reply).map((x) => ({ id: `t${x.id}`, url: x.permalink || "", author: x.username || "", text: x.text || "", posted: x.timestamp || "", replies: null }));
    },
  },
  socialfetch: {
    on: () => !!process.env.SOCIALFETCH_KEY,
    async search(q, since) {
      const p = new URLSearchParams({ query: q, startDate: new Date(since).toISOString().slice(0, 10) });
      const j = await getJson(`https://api.socialfetch.dev/v1/threads/search?${p}`, { "x-api-key": process.env.SOCIALFETCH_KEY });
      return (j.data?.posts || []).map((x) => ({ id: `t${x.id}`, url: x.url || "", author: x.author?.handle || "", text: x.text || "", posted: x.createdAt || "", replies: x.metrics?.replies ?? null }));
    },
  },
};

function create(db) {
  db.exec(SCHEMA);
  const source = () => (sources.meta.on() ? "meta" : sources.socialfetch.on() ? "socialfetch" : "");
  return {
    QUERIES,
    wanted,
    source,
    configured: () => !!source(),
    // Searches every query for posts of the last 3 days, keeps the new ones that ask for a book.
    async run() {
      db.prepare("DELETE FROM threads_finds WHERE posted < ?").run(new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
      const name = source();
      if (!name) return null;
      const since = Date.now() - 3 * DAY;
      const add = db.prepare("INSERT OR IGNORE INTO threads_finds (id, url, author, text, posted, found, query, replies) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const now = new Date().toISOString();
      const seen = new Set(),
        kept = new Set();
      let added = 0;
      const errors = [];
      for (const q of QUERIES) {
        let posts;
        try {
          posts = await sources[name].search(q, since);
        } catch (e) {
          errors.push(`${q}: ${e.message}`);
          continue;
        }
        for (const p of posts) {
          seen.add(p.id);
          if (!p.url || !wanted(p.text)) continue;
          const posted = Date.parse(p.posted) ? new Date(p.posted).toISOString() : now;
          if (Date.parse(posted) < since) continue;
          kept.add(p.id);
          added += add.run(p.id, p.url, p.author, p.text.slice(0, 2000), posted, now, q, p.replies).changes;
        }
      }
      db.set("threads:last", JSON.stringify({ at: now, source: name, seen: seen.size, kept: kept.size, added, errors }));
      if (errors.length === QUERIES.length) throw new Error(errors[0]);
      return added || null;
    },
    list() {
      return db.prepare("SELECT * FROM threads_finds ORDER BY posted DESC LIMIT 300").all();
    },
    last() {
      try {
        return JSON.parse(db.get("threads:last") || "null");
      } catch {
        return null;
      }
    },
    mark(id, state) {
      if (!["", "done", "skip"].includes(state)) return false;
      return db.prepare("UPDATE threads_finds SET state = ? WHERE id = ?").run(state, id).changes > 0;
    },
  };
}

module.exports = { create, wanted, QUERIES };
