// Threads (Claude) see production, read only (Max, 2026-11-09, after Amp's talk on agents that run the whole cycle:
// «давай 2 1 і 5»). Used by the site (web/server.js) and the reader (server/index.js), so it lives here and the
// site's image copies this one file.
//
// Who may ask: whoever holds a Fly token that can see this Fly app. A thread's container has one
// (FLY_API_TOKEN), and anyone with it can already `fly ssh` into the machine and read everything, so nothing new is
// opened. The token comes as `Authorization: Bearer <token>` (or the bare "FlyV1 …" Fly hands out); we ask
// api.fly.io once whether it sees the app and keep the answer an hour by the token's hash. The token is never
// logged or kept. Wrong tokens: at most 20 checks in 10 minutes, then 429 without asking Fly.
//
// What it gives: a read-only SQL query (SELECT / WITH / EXPLAIN) in a worker thread on its own read-only connection,
// at most 5 s and 500 rows, one at a time, 300 a day. The event loop of the site never waits for it (a long query
// would stall every page, see the 2026-11-07 stalls). E-mail addresses and anything in a column that looks like a
// secret come back masked; tables that hold only secrets (sessions, login codes, OAuth) are refused.
const crypto = require("crypto");
const { Worker } = require("worker_threads");

const HOUR = 3600000;

function gate(appName) {
  const ok = new Map(); // sha256(token) → time it was checked
  let fails = [];
  return async (req) => {
    let t = String(req.get("authorization") || "").trim();
    if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, "");
    if (t.length < 20 || t.length > 4000) return false;
    const h = crypto.createHash("sha256").update(t).digest("hex");
    const at = ok.get(h);
    if (at && Date.now() - at < HOUR) return true;
    fails = fails.filter((x) => Date.now() - x < 10 * 60000);
    if (fails.length >= 20) return "busy";
    try {
      const auth = /^fm\d_|^FlyV1 /.test(t) ? t : `Bearer ${t}`;
      const r = await fetch("https://api.fly.io/graphql", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query($n: String!) { app(name: $n) { name } }", variables: { n: appName } }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.data?.app?.name === appName) {
        if (ok.size > 50) ok.clear();
        ok.set(h, Date.now());
        return true;
      }
    } catch (e) {
      console.error(`[agent] fly check: ${e.message}`);
    }
    fails.push(Date.now());
    return false;
  };
}

// Express middleware: 404 for strangers (the address says nothing to them), 429 when too many wrong tokens.
function guard(appName, { owner } = {}) {
  const check = gate(appName);
  return async (req, res, next) => {
    if (owner && owner(req)) return next();
    const r = await check(req);
    if (r === true) return next();
    if (r === "busy") return res.status(429).json({ error: "too many wrong tokens, try in 10 minutes" });
    res.status(404).send("Not found");
  };
}

const WORKER = `
const { parentPort, workerData } = require("worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, sql, limit } = workerData;
try {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000; PRAGMA query_only = ON;");
  const st = db.prepare(sql);
  const rows = [];
  let more = false;
  if (st.iterate) {
    for (const r of st.iterate()) { if (rows.length >= limit) { more = true; break; } rows.push(r); }
  } else {
    const all = st.all(); more = all.length > limit; rows.push(...all.slice(0, limit));
  }
  db.close();
  parentPort.postMessage({ rows, more });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}`;

const SECRET_COL = /key|secret|token|hash|password|code|email|cookie|session/i;
const SECRET_KEY = /key|secret|token|session|cookie|password|code/i;
const MAIL = /[^\s@<>"'`(),:;]+@[^\s@<>"'`(),:;]+\.[a-z]{2,}/gi;
const keepMail = (s) => /@test\.invalid$/.test(s) ? s : "…@…";
function mask(row) {
  const out = {};
  const metaSecret = typeof row.key === "string" && SECRET_KEY.test(row.key);
  for (const [k, v] of Object.entries(row)) {
    if (v == null || typeof v === "number" || typeof v === "bigint") out[k] = typeof v === "bigint" ? Number(v) : v;
    else if (typeof v !== "string") out[k] = `<${v.byteLength ?? "?"} bytes>`;
    else if ((SECRET_COL.test(k) && /^[A-Za-z0-9_\-+/=.]{16,}$/.test(v)) || (k === "value" && metaSecret)) out[k] = v ? "•••" : v;
    else if (/^[[{]/.test(v)) out[k] = maskJson(v);
    else out[k] = v.replace(MAIL, keepMail);
  }
  return out;
}
// A JSON text in a column (the reader keeps whole accounts so): secret-looking fields inside it masked too.
function maskJson(v) {
  let o;
  try {
    o = JSON.parse(v);
  } catch {
    return v.replace(MAIL, keepMail);
  }
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, typeof y === "string" && ((SECRET_COL.test(k) && /^[A-Za-z0-9_\-+/=.]{16,}$/.test(y)) || /^(email|password)$/i.test(k)) ? "•••" : walk(y)]));
    return typeof x === "string" ? x.replace(MAIL, keepMail) : x;
  };
  return JSON.stringify(walk(o));
}

// sqlRunner(file, { deny }) → async (sql) => { rows, more, ms } | { error }
function sqlRunner(file, { deny = [] } = {}) {
  let busy = false;
  let day = "";
  let used = 0;
  return async (sql) => {
    sql = String(sql || "").trim().replace(/;\s*$/, "");
    if (!/^(select|with|explain)\b/i.test(sql)) return { error: "only SELECT, WITH or EXPLAIN" };
    if (sql.includes(";")) return { error: "one statement only" };
    if (/\battach\b|\bload_extension\b/i.test(sql)) return { error: "not allowed" };
    const bad = deny.find((t) => new RegExp(`\\b${t}`, "i").test(sql));
    if (bad) return { error: `table ${bad.replace(/\\b$/, "")} holds only secrets` };
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) (day = today), (used = 0);
    if (used >= 300) return { error: "300 queries today already" };
    if (busy) return { error: "another query is running, try again in a few seconds" };
    busy = true;
    used++;
    const t0 = Date.now();
    try {
      const r = await new Promise((resolve) => {
        const w = new Worker(WORKER, { eval: true, workerData: { file, sql, limit: 500 }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
        const timer = setTimeout(() => (w.terminate(), resolve({ error: "took longer than 5 s, stopped" })), 5000);
        w.once("message", (m) => (clearTimeout(timer), w.terminate(), resolve(m)));
        w.once("error", (e) => (clearTimeout(timer), resolve({ error: e.message })));
      });
      const ms = Date.now() - t0;
      console.log(`[agent] sql ${ms} ms ${r.error ? `error: ${r.error}` : `${r.rows.length} rows`}: ${sql.replace(/\s+/g, " ").slice(0, 300)}`);
      return r.error ? { error: r.error, ms } : { rows: r.rows.map(mask), more: r.more, ms };
    } finally {
      busy = false;
    }
  };
}

module.exports = { guard, sqlRunner, mask };
