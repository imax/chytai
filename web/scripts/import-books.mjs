// One-time import of Max's reading history from his site repo (maxua-v3) into web/data/seed/:
// content/Books.md (text, ratings, years) and data/books-meta.yml (author, cover, tags, links).
// The site's own parser is reused, so the books come out exactly as on maxua.com/books.
// After the import the web library lives on its own; Books.md is not read again (Max, 2026-10-18).
//
//   node web/scripts/import-books.mjs ../maxua-v3
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const SITE = path.resolve(process.argv[2] || "../maxua-v3");
const require = createRequire(path.join(SITE, "package.json"));
const { parseBooks, slugify } = require(path.join(SITE, "books-build.js"));
const yaml = require("js-yaml");

const OUT = path.resolve("web/data/seed");
const COVER_BASE = "https://maxua.com/"; // covers stay on the blog for now; images/covers/*.jpg there

const years = parseBooks(fs.readFileSync(path.join(SITE, "content/Books.md"), "utf8"));
const meta = new Map(yaml.load(fs.readFileSync(path.join(SITE, "data/books-meta.yml"), "utf8"), { schema: yaml.JSON_SCHEMA }).map((m) => [m.title, m]));

const stripMd = (s) => s.replace(/\*\*/g, "").replace(/\[(.+?)\]\((.+?)\)/g, "$1").trim();
const books = [];
const entries = [];
const seen = new Set();
let order = 0;
for (const y of years) {
  for (const it of y.items) {
    if (it.type !== "book") continue;
    const m = meta.get(it.title) || {};
    let id = m.slug || slugify(it.title);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    const links = [...(m.links || [])];
    if (m.asin && !links.some((l) => /amazon/i.test(l.url))) links.unshift({ label: "Amazon", url: `https://www.amazon.com/dp/${m.asin}` });
    if (it.srcLink && !links.some((l) => l.url === it.srcLink)) {
      const host = new URL(it.srcLink).hostname.replace(/^www\./, "").split(".")[0];
      links.push({ label: host.charAt(0).toUpperCase() + host.slice(1), url: it.srcLink });
    }
    books.push({
      id,
      title: it.name,
      series: it.volumes || 0,
      altTitle: m.alt_title || "",
      author: m.author || "",
      cover: m.cover ? COVER_BASE + m.cover : "",
      tags: m.tags || [],
      links,
      source: "books.md",
    });
    entries.push({
      book: id,
      status: "read",
      year: y.year,
      rating: it.rating,
      note: it.paras.map(stripMd).join("\n\n"),
      noteMd: it.paras.join("\n\n"),
      order: order++,
    });
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "books.json"), JSON.stringify(books, null, 1) + "\n");
fs.writeFileSync(path.join(OUT, "max.json"), JSON.stringify({ id: "max", name: "Макс Іщенко", entries, subscriptions: [] }, null, 1) + "\n");
console.log(`${books.length} books, ${entries.filter((e) => e.rating != null).length} rated, ${books.filter((b) => b.author).length} with author, ${books.filter((b) => b.cover).length} with cover`);
