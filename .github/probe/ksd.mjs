// One-off probe for the КСД thread: what ksd.ua and Google Books give a server. Not part of the site.
const UA = "Mozilla/5.0 (compatible; ChytaiBot/1.0; +https://chytai.org.ua)";
const get = async (u, o = {}) => { try { const r = await fetch(u, { headers: { "user-agent": UA, ...(o.h || {}) } }); const t = await r.text(); return { s: r.status, t }; } catch (e) { return { s: "ERR " + e.message, t: "" }; } };
const log = (...a) => console.log(...a);
for (const u of ["https://ksd.ua/", "https://ksd.ua/product/aeroport-6", "https://ksd.ua/product/aeroport-e"]) {
  const { s, t } = await get(u);
  log(`\n=== ${u} ${s} ${t.length}`);
  log("next_data:", t.includes("__NEXT_DATA__"), "next_f:", t.includes("self.__next_f"), "ld+json:", (t.match(/application\/ld\+json/g) || []).length);
  for (const m of t.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) log("LD:", m[1].slice(0, 1500));
  log("og:", [...t.matchAll(/<meta[^>]+property="og:[^"]+"[^>]*>/g)].map((m) => m[0]).join("\n"));
  const hrefs = [...new Set([...t.matchAll(/href="([^"#]+)"/g)].map((m) => m[1].replace(/\/[^/]+$/, "/*")))];
  log("href shapes:", hrefs.slice(0, 80).join(" "));
  log("api-ish:", [...new Set([...t.matchAll(/https?:\/\/[a-z0-9.-]*ksd[a-z0-9.-]*\/[^"'\s\\]*/gi)].map((m) => m[0].slice(0, 80)))].slice(0, 30).join(" "));
  log("api paths:", [...new Set([...t.matchAll(/["'](\/api\/[^"'\s\\]{2,80})/g)].map((m) => m[1]))].slice(0, 30).join(" "));
  if (u.includes("product")) {
    const i = t.indexOf("978-617"); log("isbn ctx:", t.slice(Math.max(0, i - 400), i + 200));
    const j = t.indexOf("self.__next_f"); if (j > 0) log("next_f sample:", t.slice(j, j + 3000));
  }
  const scripts = [...t.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  log("scripts:", scripts.length);
  if (u === "https://ksd.ua/") {
    const apis = new Set();
    for (const sc of scripts.slice(0, 40)) { const r = await get(new URL(sc, u).href); for (const m of r.t.matchAll(/["'`](https?:\/\/[^"'`\s]*api[^"'`\s]*|\/api\/v?\d*[^"'`\s]{0,80})["'`]/g)) apis.add(m[1]); }
    log("api in js:", [...apis].slice(0, 60).join("\n"));
  }
}
for (const u of ["https://ksd.ua/books/suchasni-avtory", "https://ksd.ua/books/suchasni-avtory?page=2", "https://ksd.ua/books/special/yeknyha", "https://ksd.ua/publishing-houses", "https://ksd.ua/sitemap.xml"]) {
  const { s, t } = await get(u);
  const prods = [...new Set([...t.matchAll(/href="(?:https:\/\/ksd\.ua)?(\/product\/[^"]+)"/g)].map((m) => m[1]))];
  log(`\n=== ${u} ${s} ${t.length} products:${prods.length} ${prods.slice(0, 5).join(" ")}`);
  log("pager:", [...new Set([...t.matchAll(/href="([^"]*page[^"]*)"/gi)].map((m) => m[1]))].slice(0, 10).join(" "), "count words:", (t.match(/[\d\s]{1,6}\s*(товар|книг)\p{L}*/giu) || []).slice(0, 5).join("|"));
  if (u.endsWith("sitemap.xml")) log("locs:", (t.match(/<loc>/g) || []).length, "product locs:", (t.match(/<loc>[^<]*\/product\//g) || []).length, t.slice(0, 600));
  if (u.endsWith("publishing-houses")) log("ph:", [...new Set([...t.matchAll(/href="([^"]*publishing-houses\/[^"]+)"/g)].map((m) => m[1]))].join(" "));
}
// Google Books: how many КСД e-books are for sale in Ukraine.
for (const q of ['inpublisher:"Клуб Сімейного Дозвілля"', 'inpublisher:"КСД"', 'inpublisher:"Книжковий Клуб"', 'inpublisher:"Family Leisure Club"', "Аеропорт Гейлі"]) {
  for (const f of ["", "&filter=paid-ebooks"]) {
    const u = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&country=UA&maxResults=40&langRestrict=uk${f}`;
    const { s, t } = await get(u);
    let j = {}; try { j = JSON.parse(t); } catch {}
    log(`\n=== GB ${q} ${f} ${s} total:${j.totalItems} ${j.error ? j.error.message : ""}`);
    for (const it of (j.items || []).slice(0, 12)) { const v = it.volumeInfo, sa = it.saleInfo; log(` - ${v.title} | ${(v.authors || []).join(", ")} | ${v.publisher} ${v.publishedDate} | ${sa.saleability} ${sa.listPrice?.amount || ""} ${sa.listPrice?.currencyCode || ""} | ${sa.buyLink || it.volumeInfo.infoLink}`); }
    const pubs = {}; for (const it of j.items || []) pubs[it.volumeInfo.publisher] = (pubs[it.volumeInfo.publisher] || 0) + 1; log(" publishers:", JSON.stringify(pubs));
    await new Promise((r) => setTimeout(r, 1500));
  }
}
