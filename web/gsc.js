// Google Search Console numbers on /admin/traffic (Max, 2026-10-26: «стату з консолі в нашій адмінці»).
// A Google Cloud service account with restricted (read-only) access to the property; its JSON key is the
// Fly secret GSC_KEY, plain or base64. The jobs process fetches once a day and keeps the result in meta
// `gsc`; the page only reads that. Google's numbers lag two or three days behind.
const crypto = require("crypto");

const DAY = 86400 * 1000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

function key() {
  const raw = (process.env.GSC_KEY || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("GSC_KEY is neither JSON nor base64 JSON");
  }
}

// An access token for the service account (the JWT bearer grant, no library needed).
async function token(k) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claims = b64({ iss: k.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: k.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claims}`).sign(k.private_key, "base64url");
  const r = await fetch(k.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

async function api(tok, path, body) {
  const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error?.message || r.status}`);
  return j;
}

// The property the account sees: the domain property first, then the https one.
async function siteOf(tok) {
  const sites = (await api(tok, "sites")).siteEntry || [];
  const ok = sites.filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
  return ["sc-domain:chytai.org.ua", "https://chytai.org.ua/"].find((u) => ok.includes(u)) || ok.find((u) => u.includes("chytai")) || null;
}

const row = (r) => ({ keys: r.keys, clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 });

async function fetchAll() {
  const k = key();
  if (!k) return null;
  const tok = await token(k);
  const site = await siteOf(tok);
  if (!site) throw new Error(`${k.client_email} has no access to chytai.org.ua in Search Console`);
  const q = (body) => api(tok, `sites/${encodeURIComponent(site)}/searchAnalytics/query`, { dataState: "all", ...body }).then((j) => (j.rows || []).map(row));
  const end = iso(Date.now());
  const days = await q({ startDate: iso(Date.now() - 120 * DAY), endDate: end, dimensions: ["date"], rowLimit: 200 });
  // Top queries and pages for the last 28 days with data (Google's last day is a few days back).
  const last = days.length ? days[days.length - 1].keys[0] : end;
  const from = iso(Date.parse(last) - 27 * DAY);
  const [queries, pages] = await Promise.all([q({ startDate: from, endDate: last, dimensions: ["query"], rowLimit: 50 }), q({ startDate: from, endDate: last, dimensions: ["page"], rowLimit: 50 })]);
  return { site, at: new Date().toISOString(), from, to: last, days: days.map((d) => ({ day: d.keys[0], clicks: d.clicks, impressions: d.impressions, position: d.position })), queries, pages };
}

function create(db) {
  return {
    configured: () => !!process.env.GSC_KEY,
    async run() {
      try {
        const data = await fetchAll();
        if (!data) return null;
        db.set("gsc", JSON.stringify(data));
        db.set("gsc:error", "");
        return true;
      } catch (e) {
        db.set("gsc:error", `${new Date().toISOString().slice(0, 16)} ${e.message}`);
        throw e;
      }
    },
    data() {
      let d = null;
      try {
        d = JSON.parse(db.get("gsc") || "null");
      } catch {}
      const error = db.get("gsc:error") || "";
      return d || error ? { ...(d || {}), error } : null;
    },
  };
}

module.exports = { create };
