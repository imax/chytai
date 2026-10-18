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

const shelves = [];

// Lobster, lobster.net.ua: WooCommerce Store API, /wp-json/wc/store/v1/products?per_page=100
{
  const items = read("lobster.json").map((p) => ({
    id: `lobster-${p.id}`,
    title: p.title,
    author: p.author,
    altTitle: p.originalTitle,
    translator: p.translator,
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
    let author = "", title = p.name, note = "";
    const m = p.name.match(/^(.*?)«(.+?)»(.*)$/);
    if (m) {
      author = m[1].replace(/(^|[\s,])(сексталогія|трилогія|комплект)(?=[\s,]|$)/i, "$1").replace(/[,\s]+$/, "").trim();
      let rest = m[3];
      const n = rest.match(/\((.*)\)/);
      if (n) (note = n[1].trim()), (rest = rest.replace(n[0], ""));
      title = (m[2] + rest).replace(/\s+,/g, ",").replace(/[,\s]+$/, "").trim();
    }
    const pre = p.categories.includes("Передзамовлення") || /передзамовлення|відправка/i.test(note);
    return {
      id: `vydavnytstvo-${p.id}`,
      title,
      author,
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
