// One-off probe for the КСД thread: ksd.ua's public GraphQL. Not part of the site.
const UA = "Mozilla/5.0 (compatible; ChytaiBot/1.0; +https://chytai.org.ua)";
const log = (...a) => console.log(...a);
const gql = async (query, variables = {}) => { try { const r = await fetch("https://prod-api.ksd.ua/graphql", { method: "POST", body: JSON.stringify({ query, variables }), headers: { "user-agent": UA, "content-type": "application/json", origin: "https://ksd.ua", referer: "https://ksd.ua/" }, signal: AbortSignal.timeout(30000) }); return { s: r.status, j: await r.json() }; } catch (e) { return { s: "ERR " + e.message, j: {} }; } };
const T = `query($n:String!){ __type(name:$n){ name kind fields { name args { name } type { name kind ofType { name kind ofType { name kind ofType { name } } } } } enumValues { name } inputFields { name } } }`;
const unwrap = (t) => { while (t && !t.name) t = t.ofType; return t?.name; };
const seen = new Set();
async function show(name, depth) {
  if (!name || seen.has(name) || depth < 0) return; seen.add(name);
  const { j } = await gql(T, { n: name }); const t = j.data?.__type; if (!t) return log("no type", name, JSON.stringify(j).slice(0, 300));
  log(`\n## ${t.name} (${t.kind})`, (t.enumValues || []).map((e) => e.name).join(" "));
  for (const f of t.fields || []) log(`  ${f.name}${f.args.length ? "(" + f.args.map((a) => a.name).join(",") + ")" : ""}: ${unwrap(f.type)}`);
  for (const f of t.fields || []) { const n = unwrap(f.type); if (n && !/^(String|Int|Float|Boolean|ID)$/.test(n)) await show(n, depth - 1); }
}
const { j: q } = await gql(`{ __schema { queryType { fields { name type { name kind ofType { name ofType { name } } } args { name type { name kind ofType { name } } } } } } }`);
const cp = q.data.__schema.queryType.fields.find((f) => f.name === "catalogProducts");
log("catalogProducts:", JSON.stringify(cp));
await show(unwrap(cp.type), 3);
for (const a of cp.args) { const n = unwrap(a.type); if (n && !/^(String|Int|ID)$/.test(n)) await show(n, 0); }
const pp = q.data.__schema.queryType.fields.find((f) => f.name === "productPage");
log("\nproductPage:", JSON.stringify(pp));
await show(unwrap(pp.type), 2);
