// One-off probe for the КСД thread: what ksd.ua gives a server. Not part of the site.
const UA = "Mozilla/5.0 (compatible; ChytaiBot/1.0; +https://chytai.org.ua)";
const get = async (u, o = {}) => { try { const r = await fetch(u, { method: o.body ? "POST" : "GET", body: o.body, headers: { "user-agent": UA, ...(o.h || {}) }, signal: AbortSignal.timeout(20000) }); const t = await r.text(); return { s: r.status, t }; } catch (e) { return { s: "ERR " + e.message, t: "" }; } };
const log = (...a) => console.log(...a);
const prods = (t) => [...new Set([...t.matchAll(/href="(?:https:\/\/ksd\.ua)?(\/product\/[^"]+)"/g)].map((m) => m[1]))];
// 1. KSD's own books: the publisher page and its pager
for (const u of ["https://ksd.ua/publishing-houses/ksd", "https://ksd.ua/publishing-houses/ksd/page-2", "https://ksd.ua/books/special/yeknyha/page-209"]) {
  const { s, t } = await get(u);
  const p = prods(t);
  log(`\n=== ${u} ${s} ${t.length} products:${p.length} ${p.slice(0, 8).join(" ")}`);
  log("pager:", [...new Set([...t.matchAll(/href="([^"]*page-\d+[^"]*)"/gi)].map((m) => m[1]))].join(" "));
  const k = t.search(/знайдено|товар(ів|и)\s*:|\d+\s+товар/i); if (k > 0) log("count ctx:", t.slice(k - 100, k + 100).replace(/<[^>]+>/g, " "));
}
// 2. GraphQL: operations the site's JS sends
const home = (await get("https://ksd.ua/product/aeroport-6")).t;
const chunks = [...home.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], "https://ksd.ua/").href);
const ops = new Set();
for (const c of chunks) { const { t } = await get(c); for (const m of t.matchAll(/(query|mutation)\s+([A-Za-z0-9_]+)\s*\(?[^{]{0,300}\{[^`"]{0,600}/g)) if (m[1] === "query") ops.add(m[0].replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 500)); }
log(`\n=== graphql ops in ${chunks.length} chunks: ${ops.size}`);
for (const o of [...ops].slice(0, 60)) log(" *", o);
const gql = async (query, variables = {}) => get("https://prod-api.ksd.ua/graphql", { body: JSON.stringify({ query, variables }), h: { "content-type": "application/json", origin: "https://ksd.ua", referer: "https://ksd.ua/" } });
let r = await gql("{ __schema { queryType { fields { name args { name } } } } }");
log("\n=== introspection", r.s, r.t.slice(0, 4000));
// 3. Language spread on product pages: Мова field for a few KSD books from the publisher page
const sample = prods((await get("https://ksd.ua/publishing-houses/ksd/page-10")).t).slice(0, 6);
for (const p of sample) {
  const { t } = await get("https://ksd.ua" + p);
  const spec = {}; for (const m of t.matchAll(/spec-name">([^<]+)<\/p><div class="[^"]*spec-value">([\s\S]*?)<\/div>/g)) spec[m[1]] = m[2].replace(/<[^>]+>/g, "").slice(0, 60);
  const ld = (t.match(/"@type":"Product"[^<]*/) || [""])[0].slice(0, 200);
  log(`\n--- ${p}`, JSON.stringify(spec), ld);
  const d = t.indexOf("Опис"); if (d > 0) log("desc ctx:", t.slice(d, d + 600).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
  const a = t.match(/href="\/authors\/[^"]+"[^>]*>([^<]+)</); log("author:", a && a[1], "h1:", (t.match(/<h1[^>]*>([^<]+)/) || [])[1]);
}
