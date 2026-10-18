// Turns the raw catalogs in web/catalogs/ (fetched from each source's public API, see the
// comments below) into web/seed/shelves.json: the public shelves Discovery shows.
//
//   node web/scripts/build-shelves.mjs
import fs from "node:fs";
import path from "node:path";

const CATALOGS = path.resolve("web/catalogs");
const OUT = path.resolve("web/seed/shelves.json");
const read = (f) => JSON.parse(fs.readFileSync(path.join(CATALOGS, f), "utf8"));
const uah = (n) => (n ? `${Math.round(n)} ₴` : "");
// WooCommerce leaves HTML entities in names («Ми &#8211; Легіон»).
const ent = (s) => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");

// «Коли завмирає серце, том шостий», «Серпанка. Том 2. Ліс зниклих духів», «Світ Едени, книга перша»:
// the series name and the volume number, so a shelf can fold the volumes into one card.
const ORD = { перший: 1, перша: 1, другий: 2, друга: 2, третій: 3, третя: 3, четвертий: 4, четверта: 4, "п’ятий": 5, "п'ятий": 5, "п’ята": 5, шостий: 6, шоста: 6, сьомий: 7, сьома: 7, восьмий: 8, восьма: 8, "дев’ятий": 9, десятий: 10 };
function volumeOf(title) {
  const m = title.match(/^(.+?)[,.]?\s+(?:том|книга|частина)\s+(\d+|[\p{L}’']+)(?=[.:\s]|$)[.:]?\s*(.*)$/iu);
  if (!m) return null;
  const n = /^\d+$/.test(m[2]) ? Number(m[2]) : ORD[m[2].toLowerCase()];
  return n ? { series: m[1].trim(), volume: n, subtitle: m[3].trim() } : null;
}

const shelves = [];

// Lobster, lobster.net.ua: WooCommerce Store API, /wp-json/wc/store/v1/products?per_page=100
{
  const items = read("lobster.json").map((p) => ({
    id: `lobster-${p.id}`,
    title: ent(p.title),
    author: ent(p.author),
    altTitle: ent(p.originalTitle),
    translator: p.translator,
    isbn: p.isbn || "",
    series: p.series || "",
    bundle: /комплект/i.test(p.title),
    cover: p.image,
    url: p.url,
    price: uah(p.price),
    status: !p.inStock ? "немає" : p.tags.includes("Передзамовлення") || p.categories.includes("Передзамовлення") ? "передзамовлення" : "є",
    isNew: p.tags.includes("Новинки"),
    genres: p.categories.filter((c) => c !== "Lobster"),
    blurb: p.blurb,
    pages: p.pages,
    year: p.year,
    language: "українська",
  }));
  shelves.push({
    id: "lobster",
    kind: "publisher",
    name: "Lobster",
    tagline: "Незалежне видавництво: фантастика та історичний нонфікшн",
    url: "https://www.lobster.net.ua/",
    items,
  });
}

// Видавництво, vydavnytstvo.com: the same WooCommerce Store API. Product names look like
// «Author, «Title» (note)»; merch is left out.
{
  const raw = read("vydavnytstvo.json").filter((p) => !p.categories.includes("Сувеніри") && !p.categories.includes("Повернення з крамниць") && !p.categories.includes("Гаражний розпродаж"));
  const items = raw.map((p) => {
    let author = "", title = ent(p.name), note = "";
    const m = title.match(/^(.*?)«(.+?)»(.*)$/);
    const bundle = /(^|[\s,])(сексталогія|трилогія|комплект)(?=[\s,]|$)/i.test(m ? m[1] : "");
    if (m) {
      author = m[1].replace(/(^|[\s,])(сексталогія|трилогія|комплект)(?=[\s,]|$)/i, "$1").replace(/[,\s]+$/, "").trim();
      let rest = m[3];
      const n = rest.match(/\((.*)\)/);
      if (n) (note = n[1].trim()), (rest = rest.replace(n[0], ""));
      title = (m[2] + rest).replace(/\s+,/g, ",").replace(/[,\s]+$/, "").trim();
    }
    const pre = p.categories.includes("Передзамовлення") || /передзамовлення|відправка/i.test(note);
    // The note mixes the edition («англійська мова», «лімітоване видання») with shipping dates; keep the edition part.
    const edition = note.split(/,\s*/).filter((t) => t && !/передзамовлення|відправка|\d{4}/i.test(t)).join(", ");
    return {
      id: `vydavnytstvo-${p.id}`,
      title,
      author,
      isbn: p.attrs.ISBN || "",
      edition,
      series: bundle ? title : volumeOf(title)?.series || "",
      volume: volumeOf(title)?.volume || 0,
      bundle,
      cover: p.image,
      url: p.url,
      price: uah(p.price),
      status: !p.inStock ? "немає" : pre ? "передзамовлення" : "є",
      isNew: pre,
      note,
      genres: p.categories.filter((c) => !["Передзамовлення", "Розпродаж"].includes(c)),
      blurb: p.blurb || p.desc,
      pages: p.attrs["Кількість сторінок"] || "",
      language: "українська",
    };
  });
  shelves.push({
    id: "vydavnytstvo",
    kind: "publisher",
    name: "Видавництво",
    tagline: "Київське видавництво: комікси, фентезі, квірліт і нонфікшн",
    url: "https://vydavnytstvo.com/",
    items,
  });
}

// Standard Ebooks: the public Atom feed of the 15 newest releases, standardebooks.org/feeds/atom/new-releases.
// Free, public-domain English ebooks; the cover lives at <book url>/downloads/cover.jpg.
{
  const items = read("standardebooks.json").map((p) => ({
    id: "se-" + p.url.replace("https://standardebooks.org/ebooks/", "").replace(/[^a-z0-9]+/gi, "-"),
    title: p.title,
    author: p.author,
    cover: `${p.url}/downloads/cover.jpg`,
    url: p.url,
    epub: p.epub,
    price: "безкоштовно",
    status: "є",
    isNew: true,
    published: p.published.slice(0, 10),
    blurb: p.summary,
    description: p.desc,
    language: "англійська",
  }));
  shelves.push({
    id: "standard-ebooks",
    kind: "free",
    name: "Standard Ebooks",
    tagline: "Вільні англійські e-book: нові випуски",
    url: "https://standardebooks.org/",
    items,
  });
}

fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), shelves }, null, 1) + "\n");
for (const s of shelves) console.log(s.id, s.items.length);
const v = shelves[1].items;
console.log(v.slice(0, 12).map((x) => `${x.author} | ${x.title} | ${x.note} | ${x.status}`).join("\n"));
console.log(v.filter((x) => !x.author).map((x) => x.title).join("\n"));
