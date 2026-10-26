// How fast the site is, day by day (Max, 2026-10-26: «у нас десь є було-стало по швидкості? … якщо немає може
// давай почнемо»). Three things are counted, only as numbers per day, never who or which address:
// - page: how long the server took over a page for a person (robots apart, as bot);
// - phone / computer: how long the page took to load in the reader's own browser (app.js sends it once a page
//   has loaded: the navigation timing, nothing else);
// - stall: how long the main loop stood still (the site answered nobody meanwhile).
// Each is a row of counts by time bucket, so the share of slow answers and a median can be read from it.
// /admin/speed shows them, with what Fly's metrics and our logs said about the days before (HISTORY).
const EDGES = [100, 200, 500, 1000, 2000, 5000, 10000]; // ms; the last bucket is everything slower
const KINDS = ["page", "bot", "phone", "computer", "phone-first", "computer-first", "stall"];

// The days before we counted, from Fly's edge metrics (all answers 2xx, covers and AI calls included, so
// slower than pages alone) and the «slow:» log lines (from 24.10 10:43 UTC), read on 2026-10-26.
const HISTORY = {
  fly: [
    // day (Kyiv), median s, 95% within s, answers, answers over 5 s
    ["2026-10-19", 0.15, 0.23, 6508, 20],
    ["2026-10-20", 0.15, 0.54, 16161, 175],
    ["2026-10-21", 0.2, 4.36, 40369, 684],
    ["2026-10-22", 0.17, 0.81, 26482, 547],
    ["2026-10-23", 0.14, 7.7, 29592, 1661],
    ["2026-10-24", 0.35, 2.73, 17977, 183],
    ["2026-10-25", 0.31, 3.3, 28270, 268],
    ["2026-10-26", 0.12, 0.22, 12843, 13], // until 08:50 Kyiv
  ],
  // pages a person or robot waited over 2 s for, per day; how long the site stood still, minutes per day
  logs: {
    before: { from: "24.10 13:43", to: "25.10 21:40", slowPages: 335, over5s: 58, worst: 121, stillMin: 34.4 },
    after: { from: "25.10 22:30", to: "26.10 08:50", slowPages: 7, over5s: 0, worst: 3.4, stillMin: 1.3 },
  },
};

// Which robot a user agent is (Max, 2026-10-26: «що це за боти, яких так багато?»): the known ones by name, the
// rest by the word in it that says bot/crawler/spider, else its product token. Only this name is kept.
const KNOWN = ["Googlebot", "Google-InspectionTool", "GoogleOther", "Google-Extended", "AdsBot-Google", "Storebot-Google", "bingbot", "BingPreview", "YandexBot", "YandexImages", "Applebot", "DuckDuckBot", "Baiduspider", "PetalBot", "SeznamBot", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Amazonbot", "meta-externalagent", "meta-externalfetcher", "facebookexternalhit", "Bytespider", "CCBot", "AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "DataForSeoBot", "BLEXBot", "serpstatbot", "Barkrowler", "ImagesiftBot", "TelegramBot", "WhatsApp", "Twitterbot", "LinkedInBot", "Slackbot", "Discordbot", "UptimeRobot", "Pinterestbot", "MojeekBot", "Qwantbot", "Timpibot", "YisouSpider", "Sogou", "TikTokSpider", "Diffbot", "cohere-ai", "AI2Bot", "Kangaroo Bot", "anthropic-ai", "curl", "Wget", "python-requests", "python-httpx", "aiohttp", "Go-http-client", "node-fetch", "axios", "HeadlessChrome"];
const KNOWN_RE = new RegExp(KNOWN.map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|"), "i");
function botName(ua) {
  const k = ua.match(KNOWN_RE);
  if (k) return KNOWN.find((x) => x.toLowerCase() === k[0].toLowerCase()) || k[0];
  const w = ua.match(/[\w.-]*(?:bot|crawl|spider|fetch|scan)[\w.-]*/i);
  return (w ? w[0] : ua.split(/[\s/;(]/)[0] || "?").slice(0, 40);
}

class Speed {
  constructor({ db, today }) {
    this.db = db;
    this.today = today;
    this.pending = new Map(); // `${day} ${kind}` -> { n, sum, b: [] }
    this.robots = new Map(); // `${day}\t${name}` -> { n, pages, ms, turned }
    setInterval(() => this.flush(), 60 * 1000).unref();
  }

  add(kind, ms) {
    if (!KINDS.includes(kind) || !(ms >= 0) || ms > 600000) return;
    const key = `${this.today()} ${kind}`;
    const x = this.pending.get(key) || { n: 0, sum: 0, b: new Array(EDGES.length + 1).fill(0) };
    x.n++;
    x.sum += ms;
    const i = EDGES.findIndex((e) => ms < e);
    x.b[i === -1 ? EDGES.length : i]++;
    this.pending.set(key, x);
  }

  // A robot's request: how many, how many of them pages, the server's milliseconds, and how many got 503.
  bot(ua, ms, page, turned) {
    const key = `${this.today()}\t${botName(ua)}`;
    if (!this.robots.has(key) && this.robots.size > 500) return;
    const x = this.robots.get(key) || { n: 0, pages: 0, ms: 0, turned: 0 };
    x.n++;
    x.ms += ms;
    if (page) x.pages++;
    if (turned) x.turned++;
    this.robots.set(key, x);
  }

  // Robots of the last `days` days, the busiest first: { name, n, pages, ms, turned, today }.
  bots(days = 7) {
    this.flush();
    const since = new Date(new Date(`${this.today()}T12:00:00`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT name, SUM(n) n, SUM(pages) pages, SUM(ms) ms, SUM(turned) turned, SUM(CASE WHEN day = ? THEN n ELSE 0 END) today FROM bots WHERE day >= ? GROUP BY name ORDER BY n DESC`).all(this.today(), since);
  }

  flush() {
    if (this.robots.size) {
      const rows = [...this.robots];
      this.robots.clear();
      try {
        const up = this.db.prepare("INSERT INTO bots (day, name, n, pages, ms, turned) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n, pages = pages + excluded.pages, ms = ms + excluded.ms, turned = turned + excluded.turned");
        for (const [key, x] of rows) up.run(...key.split("\t"), x.n, x.pages, x.ms, x.turned);
      } catch (e) {
        console.error("bots flush failed:", e.message);
      }
    }
    if (!this.pending.size) return;
    const rows = [...this.pending];
    this.pending.clear();
    try {
      const get = this.db.prepare("SELECT n, sum, buckets FROM speed WHERE day = ? AND kind = ?");
      const put = this.db.prepare("INSERT OR REPLACE INTO speed (day, kind, n, sum, buckets) VALUES (?, ?, ?, ?, ?)");
      for (const [key, x] of rows) {
        const [day, kind] = key.split(" ");
        const old = get.get(day, kind);
        const b = old ? JSON.parse(old.buckets).map((v, i) => v + x.b[i]) : x.b;
        put.run(day, kind, (old?.n || 0) + x.n, (old?.sum || 0) + x.sum, JSON.stringify(b));
      }
    } catch (e) {
      console.error("speed flush failed:", e.message);
    }
  }

  // Day -> kind -> { n, sum, b, median, p95, slow (share over 2 s) }, the newest day first.
  days(limit = 60) {
    this.flush();
    const out = new Map();
    for (const r of this.db.prepare("SELECT day, kind, n, sum, buckets FROM speed ORDER BY day DESC").all()) {
      if (!out.has(r.day)) {
        if (out.size >= limit) break;
        out.set(r.day, {});
      }
      const b = JSON.parse(r.buckets);
      out.get(r.day)[r.kind] = { n: r.n, sum: r.sum, b, median: quantile(b, r.n, 0.5), p95: quantile(b, r.n, 0.95), slow: r.n ? b.slice(EDGES.indexOf(2000) + 1).reduce((s, v) => s + v, 0) / r.n : 0 };
    }
    return out;
  }
}

// The bucket's upper edge where the q-th answer falls (an upper bound: «95% within 0.5 s»).
function quantile(b, n, q) {
  let seen = 0;
  for (let i = 0; i < b.length; i++) if ((seen += b[i]) >= n * q) return i < EDGES.length ? EDGES[i] : Infinity;
  return null;
}

module.exports = { Speed, EDGES, KINDS, HISTORY, botName };
