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
        // Readers' books without a year: the whole catalog (7 thousand more) cost about $5 for little.
        return works().filter((b) => !b.published && mine.has(b.id));
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
        const all = works().filter((b) => require("./store").fromOpenLibrary(b));
        const rank = (b) => (mine.has(b.id) ? 0 : 2) + (CYR.test(b.title) ? 0 : 1);
        return all.sort((x, y) => rank(x) - rank(y));
      },
      facts: (s) => [
        { type: "image", source: { type: "url", url: require("./store").OPEN_LIBRARY.test(s.b.cover || "") ? s.b.cover : s.b.coverFrom } }, // a kept copy is at its Open Library address too
        { type: "text", text: `The book: «${s.b.title}»${s.b.author ? ` by ${s.b.author}` : ""}, an edition in ${CYR.test(s.b.title) ? "Ukrainian" : "its original language"}.` },
      ],
      item: (s, a) => {
        const foreign = a && CYR.test(s.b.title) && !/ukrain|українськ|^uk$/i.test(a.language);
        const q = { good: "добра", dated: "застаріла", bad: "погана", broken: "немає" }[a?.quality] || "";
        return { ...book(s.b), thumb: s.b.cover, before: "Open Library", after: a ? `${q}${foreign ? `, мовою: ${a.language}` : ""}` : "", diff: !!a && (a.quality !== "good" || foreign) };
      },
      // A bad or missing picture is hidden (a placeholder looks better), and so is a foreign cover on a Ukrainian
      // book, which is asked on Readeat again for its own; a dated one stays until we look for a newer edition.
      apply: (items) => {
        const hide = {};
        const ask = [];
        for (const { s: sub, answer: a } of items) {
          if (a.quality === "bad" || a.quality === "broken") hide[sub.b.id] = sub.b.cover;
          else if (CYR.test(sub.b.title) && !/ukrain|українськ|^uk$/i.test(a.language)) {
            // The original's cover on a Ukrainian book goes («Фундація», Max: «виглядають не дуже»); Readeat may
            // bring the Ukrainian one, which shows since it is another picture.
            hide[sub.b.id] = sub.b.cover;
            if (store.lib.books[sub.b.id]) ask.push(sub.b.id);
          }
        }
        if (Object.keys(hide).length) store.hideCovers(hide);
        if (ask.length) require("./readeat").enrich(store, { ids: ask, force: true, max: ask.length, log }).then(() => store.indexSearch()).catch((e) => log(`covers readeat: ${e.message}`));
        return Object.keys(hide).length + ask.length;
      },
    },
    {
      // Max 2026-10-24: «інші книжки, які згадуються в книжці, або посилаються на неї». Haiku names both from
      // what it knows; only works our catalog has count, so a made-up title just finds nothing.
      key: "mentions",
      name: "Згадки",
      what: "Книжки, які згадуються в цій книжці, і книжки, які згадують її, з тих, що є в каталозі.",
      system: `You help Chytai, a Ukrainian book site, show which books a book talks about. Given one book, list other books that are explicitly named in its text: a book a character reads, quotes or discusses, a work the author cites or discusses, an epigraph's source, a book retold or answered. Then list well-known books that explicitly name or discuss this book in their text. Only books, not films, songs, the Bible's single verses or authors in general; not mere influence you infer, and not the author's other books unless the text itself refers to them. Give each title as usually published, the Ukrainian title if the book is known in Ukrainian, the author, and in «how» a few Ukrainian words on how it is mentioned (up to 8 words). At most 8 in each list, the most notable first. Answer «unknown» with empty lists when you are not sure which book this is or know nothing reliable: a wrong mention is worse than none.`,
      maxTokens: 1500,
      schema: (() => {
        const ref = { type: "object", properties: { title: { type: "string" }, ukrainian_title: { type: "string" }, author: { type: "string" }, how: { type: "string" } }, required: ["title", "ukrainian_title", "author", "how"], additionalProperties: false };
        return { type: "object", properties: { known: { type: "string", enum: ["yes", "unknown"] }, mentions: { type: "array", items: ref }, mentioned_in: { type: "array", items: ref } }, required: ["known", "mentions", "mentioned_in"], additionalProperties: false };
      })(),
      // Readers' books: the ones Haiku is likely to know, and the pages people open.
      candidates: () => {
        const mine = shelved();
        return works().filter((b) => mine.has(b.id));
      },
      facts: (s) => about(s.b, 300),
      item: (s, a) => {
        const self = new Set([s.b.id, ...(store.translations?.get(s.b.id) || [])]);
        const find = (r) => {
          for (const title of [r.ukrainian_title, r.title].filter(Boolean)) {
            const id = store.findWork({ title, author: r.author });
            if (id && !self.has(store.canonical(id))) return store.canonical(id);
          }
          return "";
        };
        const list = (rs) => (rs || []).map((r) => ({ ...r, id: find(r) }));
        const out = list(a?.mentions);
        const into = list(a?.mentioned_in);
        const show = (rs) => [...rs.filter((r) => r.id).map((r) => `✓ «${store.book(r.id)?.title || r.title}» (${r.how})`), ...(rs.some((r) => !r.id) ? [`поза каталогом: ${rs.filter((r) => !r.id).map((r) => r.ukrainian_title || r.title).join("; ")}`] : [])].join(" · ");
        const after = !a ? "" : a.known !== "yes" ? "не знає" : [out.length ? `Згадує: ${show(out)}` : "", into.length ? `Згадують: ${show(into)}` : ""].filter(Boolean).join(" | ") || "нічого";
        return { ...book(s.b), before: "—", after, diff: [...out, ...into].some((r) => r.id), mentions: out.filter((r) => r.id).map((r) => r.id), mentionedIn: into.filter((r) => r.id).map((r) => r.id) };
      },
    },
    {
      // Max 2026-10-25: «У деяких книжок немає опису в Про Книжку … ще одна задача для Haiku?». Only books with
      // no description anywhere: not their own, not a catalog edition's, not their Ukrainian translation's.
      key: "blurb",
      name: "Описи",
      // v2 (25.10): trial v1 had invented details (Deathworld's planet and hero, «130 сторінок») and answers cut
      // at 1024 tokens.
      // v3: «Авторка» for Adam Kay, «Ciri» in Latin letters.
      prompt: 3,
      maxTokens: 2048,
      what: "Короткий опис для «Про книжку» там, де його немає ні в книжки, ні в її видань чи перекладу.",
      system: `You write the short description for the «Про книжку» block of Chytai, a Ukrainian book site, for a book that has none. If you know this specific book well, write 2–3 sentences in Ukrainian, 35–60 words, on what it is: its kind (novel, memoir, business book…), its subject, setting or main idea. Neutral and factual like a library catalogue note: no praise or evaluative adjectives («захоплива», «блискуча»), no calls to read, no ending or twists, nothing about sales, awards, adaptations or reviews. Keep to the level of a back-cover summary you are certain of: no names of characters, planets or places from inside the story, no numbers (pages, a volume's place in a series, years, counts) unless they are in the book's title; a wrong detail is worse than a general sentence. Only Ukrainian, no English words in brackets, names in Ukrainian letters. Say «автор» unless you know the author is a woman. Natural modern Ukrainian, Ukrainian spellings of names, no Russianisms. Answer «unknown» with an empty text when you are not sure which book this is or don't know what is in it: no description is far better than a wrong one.`,
      schema: { type: "object", properties: { known: { type: "string", enum: ["yes", "unknown"] }, text: { type: "string" } }, required: ["known", "text"], additionalProperties: false },
      // Readers' books first: those are the pages people open.
      candidates: () => {
        const mine = shelved();
        const all = works().filter((b) => !b.blurb);
        return [...all.filter((b) => mine.has(b.id)), ...all.filter((b) => !mine.has(b.id))];
      },
      facts: (s) => [about(s.b), (s.b.tags || []).length ? `Genres: ${s.b.tags.slice(0, 4).join(", ")}` : ""].filter(Boolean).join("\n"),
      item: (s, a) => ({ ...book(s.b), before: "—", after: a ? (a.known === "yes" ? a.text : "не знає") : "", diff: a?.known === "yes" && !!a.text }),
      // How many of the books without a description are on readers' shelves, for the trial's header.
      finish: (st) => {
        const mine = shelved();
        st.mine = works().filter((b) => !b.blurb && mine.has(b.id)).length;
      },
      // store.book shows a stored answer where a book still has no description of its own.
      apply: (items) => {
        store.aiAnswersChanged("blurb");
        return items.filter((x) => x.answer.known === "yes" && x.answer.text).length;
      },
    },
  ];
  // Book subjects carry the book itself.
  for (const d of defs) {
    const c = d.candidates;
    if (["notbooks", "series", "year", "covers", "mentions", "blurb"].includes(d.key)) d.candidates = () => c().map((b) => ({ id: b.id, b }));
  }
  return defs.map((d) => new AiPass(d, { db, apiKey, log }));
}

module.exports = { passes };
