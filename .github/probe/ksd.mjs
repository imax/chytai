// One-off probe for the КСД thread: ksd.ua's public GraphQL. Not part of the site.
const UA = "Mozilla/5.0 (compatible; ChytaiBot/1.0; +https://chytai.org.ua)";
const log = (...a) => console.log(...a);
const gql = async (query, variables = {}) => { const r = await fetch("https://prod-api.ksd.ua/graphql", { method: "POST", body: JSON.stringify({ query, variables }), headers: { "user-agent": UA, "content-type": "application/json", origin: "https://ksd.ua", referer: "https://ksd.ua/" }, signal: AbortSignal.timeout(30000) }); const j = await r.json(); if (j.errors) log("ERR", JSON.stringify(j.errors).slice(0, 500)); return j.data; };
const LIST = `query($p:Int,$n:Int,$h:String,$f:BookFormatEnum){ catalogProducts(page:$p, per_page:$n, publishing_house_slug:$h, format:$f){ data { id slug name type available cost rating reviews_count authors { name surname } labels { alias } } meta { total last_page per_page } } }`;
const t0 = Date.now();
const all = [];
for (const f of [null, "paper", "ebook", "audio"]) {
  const d = await gql(LIST, { p: 1, n: 100, h: "ksd", f });
  log(`format ${f}: total ${d?.catalogProducts?.meta?.total}, per_page ${d?.catalogProducts?.meta?.per_page}, last_page ${d?.catalogProducts?.meta?.last_page}`);
}
let p = 1, last = 1;
do { const d = (await gql(LIST, { p, n: 100, h: "ksd" })).catalogProducts; all.push(...d.data); last = d.meta.last_page; p++; } while (p <= last && p < 200);
log(`listed ${all.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${last} pages`);
const by = (k) => all.reduce((m, x) => ((m[k(x)] = (m[k(x)] || 0) + 1), m), {});
log("types:", JSON.stringify(by((x) => x.type)), "available:", JSON.stringify(by((x) => x.available)));
log("komplekt:", all.filter((x) => /^комплект/i.test(x.name)).length, "reviews>0:", all.filter((x) => x.reviews_count > 0).length);
log("sample:", all.slice(0, 5).map((x) => `${x.name} | ${x.authors.map((a) => a.name + " " + a.surname).join(", ")} | ${x.type} ${x.cost} ${x.available}`).join("\n  "));
// Whole-shop totals (all publishers), for scale
const whole = await gql(LIST, { p: 1, n: 1 }); log("whole shop:", whole?.catalogProducts?.meta?.total);
// Product details for a sample
const PAGE = `query($s:String!){ productPage(slug:$s){ name type isbn original_name translators publishing_year pages available release_date main_text e_version { slug type available cost } paper_version { slug } categories { name } series { name } publishing_house { name slug } specifications { type name values { name } } image { medium_x2 { url } } } }`;
const step = Math.max(1, Math.floor(all.length / 150));
const sample = all.filter((_, i) => i % step === 0).slice(0, 150);
const langs = {}, orig = {}, years = {}; let isbn = 0, ol = 0, trans = 0, blurb = 0, ru = [], t1 = Date.now();
for (const x of sample) {
  const d = (await gql(PAGE, { s: x.slug }))?.productPage; if (!d) continue;
  const spec = Object.fromEntries((d.specifications || []).map((s) => [s.type, s.values.map((v) => v.name).join("/")]));
  langs[spec.language || "?"] = (langs[spec.language || "?"] || 0) + 1;
  orig[spec.original_language || "?"] = (orig[spec.original_language || "?"] || 0) + 1;
  const y = d.publishing_year ? Math.floor(d.publishing_year / 5) * 5 : "?"; years[y] = (years[y] || 0) + 1;
  if (d.isbn) isbn++; if (d.original_name) ol++; if (d.translators) trans++; if ((d.main_text || "").length > 100) blurb++;
  if (/рос/i.test(spec.language || "")) ru.push(d.name);
}
log(`details for ${sample.length} in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
log("language:", JSON.stringify(langs)); log("original language:", JSON.stringify(orig)); log("year (5y):", JSON.stringify(years));
log(`isbn ${isbn}, original_name ${ol}, translators ${trans}, blurb ${blurb}; russian: ${ru.slice(0, 10).join("; ")}`);
const one = (await gql(PAGE, { s: "aeroport-6" })).productPage; log("aeroport-6:", JSON.stringify({ ...one, main_text: (one.main_text || "").slice(0, 300) }));
const e = (await gql(PAGE, { s: "aeroport-e" })).productPage; log("aeroport-e:", JSON.stringify({ ...e, main_text: (e.main_text || "").slice(0, 100) }));
