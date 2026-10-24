// The catalog passes on aipass.js (Max, 2026-10-24: «Ідеї клас, беремо всі», and covers: «ми вчора пододавали
// багато "старих" обкладинок від перших редакцій, які зараз виглядають не дуже»). Each is a trial for now:
// Haiku's answer next to what the site has, on /admin/ai/<key>; applying comes after Max has looked.

const { AiPass } = require("./aipass");
const { isRussian, norm } = require("./store");

const CYR = /[а-яіїєґ]/i;
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
const publishers = (b) => [...new Set([...(b.links || []), ...(b.editions || []).flatMap((e) => e.links || [])].map((l) => l.label).filter(Boolean))].slice(0, 4).join(", ");
const about = (b, n = 400) =>
  [
    `Title: ${b.title}`,
    b.altTitle ? `Original title: ${b.altTitle}` : "",
    b.author ? `Author: ${b.author}` : "",
    b.published ? `Year on the site: ${b.published}` : "",
    publishers(b) ? `Publisher or shop: ${publishers(b)}` : "",
    b.blurb ? `Description: ${clip(b.blurb, n)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

// Two author pages are one person only if their surnames start with the same two letters once transliterated («Совелл» and
// «Соуелл», «Haidt» and «Гайдт»): Haiku once named Lewis Carroll for Jane Carruth, a reteller of his book.
const { slugify } = require("./store");
const head = (name) => slugify(String(name || "").trim().split(/\s+/).pop()).replace(/^the-/, "").replace(/h/g, "g").replace(/k/g, "c").slice(0, 2);
const kin = (a, b) => a.names.some((x) => b.names.some((y) => head(x).length === 2 && head(x) === head(y)));

function passes({ store, social, db, apiKey, log }) {
  // Readers' works first: they are what people look at.
  const shelved = () => new Set(social.all().map((x) => store.canonical(x.id)));
  const works = () => {
    const mine = shelved();
    const ids = [...new Set([...mine, ...store.workIds()])];
    return ids.map((id) => store.book(id)).filter((b) => b && !isRussian(b));
  };
  const book = (b) => ({ id: b.id, title: b.title, author: b.author || "" });

  const defs = [
    {
      key: "dupes",
      name: "Дублікати",
      what: "Групи з /admin/dupes: та сама книжка (тоді яку сторінку лишити) чи різні.",
      system: `You help Chytai, a Ukrainian book site, clean duplicates. You get two or more catalog entries with the same author and a similar title. Say «same» when they are one work (editions, formats, a reissue, a title with or without a subtitle), «different» when they are different books (different volumes or parts, a companion book, a different work with a similar name), «unsure» when you can't tell. For «same», pick the entry to keep: the one with the fullest, most standard title and data.`,
      schema: { type: "object", properties: { verdict: { type: "string", enum: ["same", "different", "unsure"] }, keep: { type: "integer" } }, required: ["verdict", "keep"], additionalProperties: false },
      candidates: () => store.dupes().map((g) => ({ id: g.map((x) => x.id).join("|"), group: g })),
      facts: (s) => s.group.map((x, i) => `Entry ${i}:\n${about(store.book(x.id) || x, 200)}\nEditions in catalogs: ${x.editions}`).join("\n\n"),
      item: (s, a) => ({
        id: s.id,
        title: s.group.map((x) => x.title).join(" / "),
        author: s.group[0].author,
        before: `${s.group.length} окремі сторінки`,
        after: a ? (a.verdict === "same" ? `та сама, лишити «${s.group[a.keep]?.title || "?"}»` : a.verdict === "different" ? "різні книжки" : "не знає") : "",
        diff: a?.verdict === "same",
        links: s.group.map((x) => x.id),
      }),
      // «Same» merges into the page Haiku keeps, like «Лишити цю» on /admin/dupes (undo there); «different»
      // and «unsure» stay on that list for a human.
      apply: (items) => {
        const groups = items.filter((x) => x.answer.verdict === "same" && x.s.group[x.answer.keep]).map((x) => [x.s.group.map((g) => g.id), x.s.group[x.answer.keep].id]);
        if (groups.length) store.decideMany(groups);
        return groups.length;
      },
    },
    {
      key: "notbooks",
      name: "Не книжки",
      what: "Листівки, календарі, блокноти, набори, ігри та інше, що магазини тримають серед книжок.",
      system: `You help Chytai, a Ukrainian book site, keep its catalog to books. Given one item from a bookshop's catalog, say whether it is a book a person reads (any genre, including picture books, comics, poetry, audiobooks and box sets of books) or not a book: postcards, calendars, planners, notebooks, diaries to fill in, colouring or sticker books, puzzles, games, posters, bookmarks, gift certificates, merchandise. Answer «unsure» when you can't tell, and name what the item is in a few Ukrainian words.`,
      schema: { type: "object", properties: { kind: { type: "string", enum: ["book", "not_book", "unsure"] }, what: { type: "string" } }, required: ["kind", "what"], additionalProperties: false },
      candidates: () => {
        const mine = shelved();
        const all = works().filter((b) => !mine.has(b.id) && !store.lib.books[b.id]);
        const odd = /листів|календар|планер|блокнот|щоденник|розмальов|наліпк|пазл|гра\b|ігр|постер|плакат|закладк|сертифікат|набір|комплект|скетчбук|зошит|шопер|чашк|значк/i;
        return [...all.filter((b) => odd.test(b.title)), ...all.filter((b) => !odd.test(b.title))];
      },
      facts: (s) => about(s.b, 300),
      item: (s, a) => ({ ...book(s.b), before: "книжка", after: a ? (a.kind === "book" ? "книжка" : a.kind === "not_book" ? `не книжка: ${a.what}` : `не знає: ${a.what}`) : "", diff: a?.kind === "not_book" }),
      // Not-books leave the works (search, genres, recommendations) in linkEditions; the shop's shelf keeps them.
      apply: (items) => {
        store.aiAnswersChanged("notbooks");
        store.linkEditions();
        store.linkTranslations();
        store.indexSearch();
        return items.filter((x) => x.answer.kind === "not_book").length;
      },
    },
    {
      key: "series",
      name: "Серії",
      what: "Назва серії й номер книжки в ній там, де сайт серії не знає.",
      system: `You help Chytai, a Ukrainian book site, find book series. Given one book, say whether it belongs to a numbered or named series of separate books by its author (a novel cycle, a trilogy, a saga), and if so give the series name as it is commonly known in the language of this edition, and the book's number in it. Not a series: a publisher's imprint or collection, a standalone book, an anthology. Answer «unknown» when you are not sure which book this is.`,
      schema: { type: "object", properties: { series: { type: "string", enum: ["yes", "no", "unknown"] }, name: { type: "string" }, number: { type: "string" } }, required: ["series", "name", "number"], additionalProperties: false },
      candidates: () => {
        const mine = shelved();
        return works().filter((b) => mine.has(b.id) && !b.series && !store.cycleOf(b.id));
      },
      facts: (s) => about(s.b),
      item: (s, a) => ({ ...book(s.b), before: "—", after: a ? (a.series === "yes" ? `${a.name}${a.number ? `, №${a.number}` : ""}` : a.series === "no" ? "не серія" : "не знає") : "", diff: a?.series === "yes" }),
    },
    {
      key: "year",
      name: "Рік першої публікації",
      what: "Рік першого видання твору (не цього перекладу) там, де його немає або він дивний.",
      system: `You help Chytai, a Ukrainian book site, date books. Given one book, give the year the work was first published, in its original language (not the year of this translation or edition). For ancient works give a negative year or 0 if unknown. Answer «unknown» when you are not sure which book this is.`,
      schema: { type: "object", properties: { known: { type: "string", enum: ["yes", "unknown"] }, year: { type: "integer" } }, required: ["known", "year"], additionalProperties: false },
      candidates: () => {
        const mine = shelved();
        // Readers' books without a year first, then the rest of the catalog without one.
        const all = works().filter((b) => !b.published);
        return [...all.filter((b) => mine.has(b.id)), ...all.filter((b) => !mine.has(b.id))];
      },
      facts: (s) => about(s.b, 300),
      item: (s, a) => {
        const was = Number(s.b.published) || 0;
        const now = a?.known === "yes" ? a.year : 0;
        return { ...book(s.b), before: was ? String(was) : "—", after: a ? (now ? String(now) : "не знає") : "", diff: !!now && (!was || Math.abs(was - now) > 1) };
      },
      // Fills only a missing year (store.book reads the answers); a year we have stays.
      apply: (items) => {
        store.aiAnswersChanged("year");
        return items.filter((x) => x.answer.known === "yes" && x.answer.year > 0 && !x.s.b.published).length;
      },
    },
    {
      key: "authors",
      name: "Автори",
      what: "Різні написання одного автора на різних сторінках, без Вікіданих.",
      system: `You help Chytai, a Ukrainian book site, merge author spellings. Given the names a catalog uses for one author and some of their book titles, give the author's name as written in the original language (Latin script for most foreign authors) and the standard Ukrainian spelling. Answer «unknown» when you can't tell who this is, for example a common name with no telling books.`,
      schema: { type: "object", properties: { known: { type: "string", enum: ["yes", "unknown"] }, original: { type: "string" }, ukrainian: { type: "string" } }, required: ["known", "original", "ukrainian"], additionalProperties: false },
      candidates: () => {
        const mine = shelved();
        const list = store.authors.list.filter((a) => !a.qid);
        return [...list.filter((a) => a.ids.some((id) => mine.has(id))), ...list.filter((a) => !a.ids.some((id) => mine.has(id)))].map((a) => ({ id: a.key, a }));
      },
      facts: (s) => `Names used: ${s.a.names.join("; ")}\nBooks: ${s.a.ids.slice(0, 5).map((id) => store.book(id)?.title).filter(Boolean).join("; ")}`,
      item: (s, a) => {
        // Another author page that the same person already has: the merge Haiku suggests.
        const other = a?.known === "yes" && [a.original, a.ukrainian].map((n) => store.authors.byName(n)).find((x) => x && x.key !== s.a.key && kin(s.a, x));
        return { id: s.id, title: s.a.name, author: "", before: s.a.names.join("; "), after: a ? (a.known === "yes" ? `${a.original} / ${a.ukrainian}${other ? ` → злити з «${other.name}»` : ""}` : "не знає") : "", diff: !!other, merge: other ? other.slug : "" };
      },
      // A merge into another page goes in the owner's joins (undo on the author page, «роз'єднати»).
      apply: (items) => {
        const j = require("./authors").ownerJoins(store);
        let n = 0;
        for (const { item, s: sub } of items) {
          const other = item.merge && store.authors.bySlug.get(item.merge);
          if (!other || other.key === sub.a.key || j.some(([x, y]) => x === sub.a.names[0] && y === other.names[0])) continue;
          j.push([sub.a.names[0], other.names[0]]);
          n++;
        }
        if (n) {
          store.db.set("authors:join", JSON.stringify(j));
          store.linkTranslations(); // rebuilds the author index
        }
        return n;
      },
      // Two pages in this sample that Haiku names as one person.
      finish: (st) => {
        const byName = new Map();
        for (const x of st.items) if (x.answer?.known === "yes") (byName.get(norm(x.answer.original)) || byName.set(norm(x.answer.original), []).get(norm(x.answer.original))).push(x);
        for (const g of byName.values()) if (g.length > 1) for (const x of g) if (!x.diff) Object.assign(x, { diff: true, after: `${x.after} → та сама людина, що «${g.find((y) => y !== x).title}»` });
      },
    },
    {
      key: "covers",
      name: "Обкладинки",
      what: "Обкладинки з Open Library: старі перші видання, погані скани, обкладинка іншомовного видання на українській книжці.",
      maxTokens: 512,
      system: `You help Chytai, a Ukrainian book site, judge book covers. You see the cover the site shows for one book. Say whether it is «good» (a clean, readable modern cover of this book), «dated» (an old first-edition or vintage cover that looks out of place next to today's books), «bad» (a poor scan, a blank or library binding, a placeholder, a wrong book) or «broken» (no image). Also say the language printed on the cover.`,
      schema: { type: "object", properties: { quality: { type: "string", enum: ["good", "dated", "bad", "broken"] }, language: { type: "string" } }, required: ["quality", "language"], additionalProperties: false },
      candidates: () => {
        const mine = shelved();
        const all = works().filter((b) => /openlibrary\.org/.test(b.cover || ""));
        const rank = (b) => (mine.has(b.id) ? 0 : 2) + (CYR.test(b.title) ? 0 : 1);
        return all.sort((x, y) => rank(x) - rank(y));
      },
      facts: (s) => [
        { type: "image", source: { type: "url", url: s.b.cover } },
        { type: "text", text: `The book: «${s.b.title}»${s.b.author ? ` by ${s.b.author}` : ""}, an edition in ${CYR.test(s.b.title) ? "Ukrainian" : "its original language"}.` },
      ],
      item: (s, a) => {
        const foreign = a && CYR.test(s.b.title) && !/ukrain|українськ|^uk$/i.test(a.language);
        const q = { good: "добра", dated: "застаріла", bad: "погана", broken: "немає" }[a?.quality] || "";
        return { ...book(s.b), thumb: s.b.cover, before: "Open Library", after: a ? `${q}${foreign ? `, мовою: ${a.language}` : ""}` : "", diff: !!a && (a.quality !== "good" || foreign) };
      },
      // A bad or missing picture is hidden (a placeholder looks better); a Ukrainian book with a foreign cover
      // is asked on Readeat again for its own; a dated one stays until we look for a newer edition.
      apply: (items) => {
        const hide = {};
        const ask = [];
        for (const { s: sub, answer: a } of items) {
          if (a.quality === "bad" || a.quality === "broken") hide[sub.b.id] = sub.b.cover;
          else if (CYR.test(sub.b.title) && !/ukrain|українськ|^uk$/i.test(a.language) && store.lib.books[sub.b.id]) ask.push(sub.b.id);
        }
        if (Object.keys(hide).length) store.hideCovers(hide);
        if (ask.length) require("./readeat").enrich(store, { ids: ask, force: true, max: ask.length, log }).then(() => store.indexSearch()).catch((e) => log(`covers readeat: ${e.message}`));
        return Object.keys(hide).length + ask.length;
      },
    },
  ];
  // Book subjects carry the book itself.
  for (const d of defs) {
    const c = d.candidates;
    if (["notbooks", "series", "year", "covers"].includes(d.key)) d.candidates = () => c().map((b) => ({ id: b.id, b }));
  }
  return defs.map((d) => new AiPass(d, { db, apiKey, log }));
}

module.exports = { passes };
