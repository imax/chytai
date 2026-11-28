// «Нотатки» (Max 2026-11-25, variant A «Теми» of canvas 66Ec9Ssa7vR6q7qjgKfMUm; it began on 2026-11-23 as «Scratchpad»,
// variant A of canvas 5vFceFdJnh3oNewFR6TgT4): a reader's research folder. Each entry is a topic, an author or a book
// (or a thought Opus can't place); it keeps the reader's later thoughts (`thoughts`, each may get Opus's `reply`: where
// to dig next), the reader's own books that belong to it (Opus's `ai.have` by the library the page sends, plus
// `mine` by hand, minus `notMine`), and the books Opus suggests. It began as an inbox for reading, as in GTD. Walking with a podcast, a reader jots «король Артур» (a topic, an era, money as a
// subject, an author, a book) or takes a photo (a cover, a poster, a page), and later sorts it out. Each entry is read by
// Opus at once: what it is, a few sentences of background and 3–5 books, the first the one to start with; the catalog
// then gives each book its page and cover (index.js `catalogFind`). «Уточнити» asks again with the reader's words.
// Kept per account in accounts/<id>/scratch.json (at most MAX entries, the oldest sorted ones go first) and photos
// in accounts/<id>/scratch/<entry>.jpg (at most MAX_PHOTOS; an older entry keeps its text and answer). Both go with
// the account. The page is src/renderer/scratch.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { measure } = require("./aimeter");

const MODEL = "claude-opus-5-5";
const MAX = 500;
const MAX_PHOTOS = 100;
const TEXT_MAX = 1000;
const THOUGHTS_MAX = 100;
const LIB_MAX = 300; // own books named to Opus
const SHELF_MAX = 1000; // books of the site's shelf named to Opus
const SEEN_MAX = 80; // suggested titles kept so «Порадити ще» doesn't repeat them
// The site's shelf statuses as Opus reads them and as the topic shows them.
const STATUS = { read: "прочитано", reading: "читає", want: "хоче прочитати", abandoned: "кинув", "": "на полиці" };
const KINDS = ["topic", "era", "author", "book", "unclear"];

const SYSTEM = `You help a Ukrainian reader keep an inbox of things to read about later. While walking, listening to a podcast or talking to a friend, the reader jots a few words or takes a photo: a topic (King Arthur, money, habits), an era (Victorian England, the Cossack Hetmanate), an author's name, a book's title, or something half-remembered. Later the reader opens the entry and wants to decide quickly whether and what to read.

Work out what the reader meant and answer in Ukrainian:
- kind: "topic", "era", "author", "book", or "unclear" when you cannot tell what was meant.
- title: the subject's plain name, 1–5 words, as a Ukrainian reader would call it («Король Артур», «Вікторіанська Англія», «Психологія грошей», «Сергій Плохій»). A book's title is its Ukrainian edition's title when there is one, else the original.
- about: 2–4 short plain sentences of background that make the reader want to read on: what this is and what is interesting about it. For a book: what it is about and why people read it. For an author: who they are and what they are known for. No praise words, no «ви», no lists.
- books: 3–5 books, the first the one to start with. Mix fiction and nonfiction when the subject has both. For a book: that book first, then 2–3 that readers of it go on to. For an author: their books in the order to read them. Each book:
  - title: the original title; author: the original author's name in Latin or as written in the original;
  - title_uk / author_uk: the Ukrainian edition's title and the author's name in Ukrainian only when you are sure a Ukrainian translation was published; otherwise empty strings (never translate a title yourself);
  - lang: the original language code ("en", "uk", "fr"…);
  - why: one short Ukrainian sentence, at most 12 words, why this book for this subject;
  - nonfiction: true or false.
  Never suggest a book the reader already has: one in «Книжки читача» or on «Полиця читача на Chytai» (whatever its status), in any edition or translation, nor one under «Уже пропонували», «Читачеві не цікаві» or «Читач сам додав у тему».
- guesses: only for "unclear": 2–3 short Ukrainian guesses of what was meant (an author and a book, a topic), each at most 8 words; otherwise an empty list. For "unclear" leave books empty and about empty.

- have: the numbers of the reader's own books (the list after «Книжки читача:», when there is one) that clearly belong to this subject, read or not; at most 12; an empty list when none or no list.
- shelf: the numbers of the books on «Полиця читача на Chytai:» (when there is one) that clearly belong to this subject, whatever their status; at most 12; an empty list when none or no list.
- reply: only when the request has «Думка читача:» lines: one or two short Ukrainian sentences on the LAST thought: where to dig next (a book from your list, an angle, a question worth looking into). No «ви», no praise. Otherwise an empty string.

Rules: never recommend Russian authors or Russian-language editions; prefer books that exist in Ukrainian when they are as good. Name only real books you are sure exist. Answer only with the JSON.

A photo may show a book cover, a page, a poster, a screen with a podcast or an article: the subject is what the reader would want to read about from it. Lines after «Уточнення читача:» and «Думка читача:» are the reader's later words: follow them (a guess they picked, «щось українською», «тільки нонфікшн», a question the reader wants to dig into) and answer the whole entry anew, the books too. Books after «Читач сам додав у тему:» are the ones the reader chose for this subject by hand: they show what the reader wants from it, so suggest books close to them and count them in «have» / «shelf» when listed there. Books after «Читач прибрав з теми:» are the reader's own books that are not about this subject: leave them out of «have».`;

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: KINDS },
    title: { type: "string" },
    about: { type: "string" },
    books: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          author: { type: "string" },
          title_uk: { type: "string" },
          author_uk: { type: "string" },
          lang: { type: "string" },
          why: { type: "string" },
          nonfiction: { type: "boolean" },
        },
        required: ["title", "author", "title_uk", "author_uk", "lang", "why", "nonfiction"],
        additionalProperties: false,
      },
    },
    guesses: { type: "array", items: { type: "string" } },
    have: { type: "array", items: { type: "integer" } },
    shelf: { type: "array", items: { type: "integer" } },
    reply: { type: "string" },
  },
  required: ["kind", "title", "about", "books", "guesses", "have", "shelf", "reply"],
  additionalProperties: false,
};

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const fold = (s) => String(s || "").toLowerCase().replace(/ґ/g, "г").replace(/[ʼ’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Two spellings of one name a letter apart: «Гаузел» / «Гаусел», «Лярю» / «Ларю».
function near(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const [x, y] = a.length >= b.length ? [a, b] : [b, a];
  return x.slice(i + 1) === y.slice(i + (x.length === y.length ? 1 : 0));
}
// A name's last word of 3+ letters: «Т. Г. Вайт» → «вайт», «White» → «white».
const surname = (name) => fold(name).split(" ").filter((w) => w.length > 2).pop() || "";
// A title's head: before «, або» / «, or» or « (»: «Бойня номер п'ять, або Дитячий хрестовий похід» = «Бойня номер п'ять».
const head = (t) => fold(String(t || "").split(/,\s*(?:або|or)\s|\s\(/i)[0]);
// The shelf's row for a suggested book: the same catalog page, or the same title (or its head) and an author's word.
function onShelf(b, site) {
  const ts = [b.ctitle, b.title_uk, b.title].filter(Boolean);
  const names = [b.cauthor, b.author_uk, b.author].flatMap((a) => fold(a).split(" ")).filter((w) => w.length > 3);
  return site.find((s) => {
    if (b.href && s.href === b.href) return true;
    const h = head(s.t);
    if (!h || !ts.some((t) => fold(t) === fold(s.t) || head(t) === h)) return false;
    const by = fold(s.a);
    return h.length >= 12 || names.some((w) => by.includes(w));
  }) || null;
}

class Scratch {
  // dir: the accounts folder; find(q) → the catalog's { books: [{ title, author, year, cover, href }] };
  // spend(acct, usd) after each call.
  constructor({ dir, apiKey, find, spend = () => {}, log = console.log }) {
    Object.assign(this, { dir, apiKey, find, spend, log });
    this.running = new Set(); // acct\tid
  }

  file(acct) {
    return path.join(this.dir, acct, "scratch.json");
  }
  photoFile(acct, id) {
    return /^[a-f0-9]{12}$/.test(id) ? path.join(this.dir, acct, "scratch", `${id}.jpg`) : null;
  }
  read(acct) {
    try {
      return JSON.parse(fs.readFileSync(this.file(acct), "utf8")).items || [];
    } catch {
      return [];
    }
  }
  write(acct, items) {
    fs.mkdirSync(path.dirname(this.file(acct)), { recursive: true });
    const tmp = `${this.file(acct)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items }));
    fs.renameSync(tmp, this.file(acct));
  }
  // Changes one entry in place (read, change, write in one go: no await in between).
  update(acct, id, change) {
    const items = this.read(acct);
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    change(it);
    this.write(acct, items);
    return it;
  }

  // The entries, newest first. One left waiting by a restart (a deploy) is asked again.
  list(acct, canRun) {
    const items = this.read(acct);
    for (const it of items) if ((it.status === "wait" || it.status === "limit") && !this.running.has(`${acct}\t${it.id}`) && canRun()) this.run(acct, it.id);
    return items;
  }

  // The place of a suggested book in the entry's list: `i` when its title is `title` (or no title is given), else
  // the book with that title; -1 = gone. A change queued offline names both (web-bridge.js).
  indexOf(acct, id, i, title) {
    if (!title) return i;
    const books = this.read(acct).find((x) => x.id === id)?.ai?.books || [];
    const t = fold(title);
    const is = (b) => b && [b.title, b.title_uk].some((x) => x && fold(x) === t);
    return is(books[i]) ? i : books.findIndex(is);
  }

  // A suggested book the reader doesn't want («Не цікаво», Max 2026-11-25): out of the topic, and its title kept in
  // `no` so the next answers don't bring it back.
  decline(acct, id, i) {
    return this.update(acct, id, (x) => {
      const b = x.ai?.books?.[i];
      if (!b) return;
      x.no = [...new Set([...(x.no || []), b.title_uk || b.title])].slice(-SEEN_MAX);
      x.ai.books.splice(i, 1);
      x.touched = Date.now();
    });
  }

  // The list as the page gets it, a suggestion found on the site's shelf moved to the topic's shelf books, also for
  // answers from before the shelf was asked (nothing kept: the next answer keeps its own).
  withShelf(items, site) {
    if (!site?.length) return items;
    return items.map((it) => {
      const books = it.ai?.books || [];
      const hits = books.map((b) => (b.wanted ? null : onShelf(b, site)));
      if (!hits.some(Boolean)) return it;
      const shelf = [...(it.ai.shelf || [])];
      for (const s of hits) if (s && !shelf.some((x) => (x.href || x.t) === (s.href || s.t))) shelf.push({ t: s.t, a: s.a, s: s.s, href: s.href, cover: s.cover, year: s.year || null });
      // Marked, not taken out: the page's book numbers are the kept list's.
      return { ...it, ai: { ...it.ai, books: books.map((b, i) => (hits[i] ? { ...b, onShelf: true } : b)), shelf } };
    });
  }

  add(acct, { text, photo, voice }) {
    text = String(text || "").trim().slice(0, TEXT_MAX);
    if (!text && !photo) return null;
    const id = crypto.randomBytes(6).toString("hex");
    const items = this.read(acct);
    const it = { id, text, photo: !!photo, voice: !!voice, at: Date.now(), state: "new", status: "wait", ask: [], thoughts: [] };
    if (photo) {
      fs.mkdirSync(path.join(this.dir, acct, "scratch"), { recursive: true });
      fs.writeFileSync(this.photoFile(acct, id), photo);
    }
    items.unshift(it);
    this.trim(acct, items);
    this.write(acct, items);
    return it;
  }

  // At most MAX entries (sorted ones go first, the oldest of them) and MAX_PHOTOS photos.
  trim(acct, items) {
    while (items.length > MAX) {
      let i = items.map((x) => x.state !== "new").lastIndexOf(true);
      if (i < 0) i = items.length - 1;
      const [gone] = items.splice(i, 1);
      if (gone.photo) fs.rmSync(this.photoFile(acct, gone.id), { force: true });
    }
    items.filter((x) => x.photo).slice(MAX_PHOTOS).forEach((x) => {
      fs.rmSync(this.photoFile(acct, x.id), { force: true });
      x.photo = false;
    });
  }

  remove(acct, id) {
    const items = this.read(acct);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    if (items[i].photo) fs.rmSync(this.photoFile(acct, id), { force: true });
    items.splice(i, 1);
    this.write(acct, items);
    return true;
  }

  // «Готово» / «Не цікаво» / back to the new ones.
  setState(acct, id, state) {
    if (!["new", "done", "skip"].includes(state)) return null;
    return this.update(acct, id, (it) => ((it.state = state), (it.sortedAt = state === "new" ? 0 : Date.now())));
  }

  // «Уточнити» or a guess picked: the entry is asked again with these words after it.
  refine(acct, id, words) {
    words = clean(words, 300);
    if (!words) return null;
    const it = this.update(acct, id, (x) => ((x.ask = [...(x.ask || []), words].slice(-5)), (x.status = "wait")));
    return it;
  }

  // A thought added to a topic: kept, and the topic is asked again with it (Opus answers it in `reply`).
  think(acct, id, { text, voice }) {
    text = String(text || "").trim().slice(0, TEXT_MAX);
    if (!text) return null;
    const t = { id: crypto.randomBytes(4).toString("hex"), text, at: Date.now(), voice: !!voice };
    return this.update(acct, id, (x) => {
      x.thoughts = [...(x.thoughts || []), t].slice(-THOUGHTS_MAX);
      x.replyTo = t.id;
      x.status = "wait";
      x.touched = Date.now();
    });
  }
  unthink(acct, id, tid) {
    return this.update(acct, id, (x) => {
      x.thoughts = (x.thoughts || []).filter((t) => t.id !== tid);
      x.touched = Date.now();
    });
  }
  // One of the reader's books put into the topic by hand (when: `added`, so the newest stand first), or taken out.
  link(acct, id, book, on) {
    book = String(book || "").slice(0, 500);
    if (!book) return null;
    return this.update(acct, id, (x) => {
      x.mine = (x.mine || []).filter((b) => b !== book);
      x.notMine = (x.notMine || []).filter((b) => b !== book);
      if (on) x.mine.unshift(book);
      else x.notMine.unshift(book);
      x.mine = x.mine.slice(0, 200);
      x.notMine = x.notMine.slice(0, 200);
      const at = x.added || {};
      x.added = Object.fromEntries(x.mine.map((b) => [b, b === book ? Date.now() : at[b] || 0]));
      x.touched = Date.now();
    });
  }
  // A book Opus suggested, added to the topic by hand («Додати в тему», `wanted`; Max 2026-11-25: only the topic,
  // not the site's shelf) or taken out again.
  wanted(acct, id, i, on = true) {
    return this.update(acct, id, (x) => {
      const b = x.ai?.books?.[i];
      if (!b) return;
      if (on) b.wanted = Date.now();
      else if (b.mention) x.ai.books.splice(i, 1); // a mentioned book was never Opus's suggestion: out altogether
      else delete b.wanted;
      x.touched = Date.now();
    });
  }
  // A book named in an explanation or a book's text, put into the topic from its card («Згадані книжки», Max
  // 2026-11-28, variant A of canvas 4NY9k5VDz5rgvscFk2sGwV, bot №87): kept like a suggestion added by hand (`wanted`,
  // so the topic shows it and Opus hears of it), `mention` with the book it was met in for the line under it. A topic
  // still being answered has no `ai` yet: the book waits in one, and `run` keeps it (it merges the books of the
  // entry as it is when the answer comes). on = false takes it out again.
  mention(acct, id, m, on = true) {
    const title = clean(m?.title, 200);
    if (!title) return null;
    const author = clean(m?.author, 200);
    const href = /^https:\/\//.test(m?.href || "") ? clean(m.href, 500) : "";
    const same = (b) => (href && b.href === href) || (fold(b.title_uk || b.title) === fold(title) && (!author || !b.author || near(surname(b.author_uk || b.author), surname(author))));
    return this.update(acct, id, (x) => {
      x.ai ??= { books: [] };
      x.ai.books ??= [];
      const i = x.ai.books.findIndex(same);
      if (!on) {
        if (i < 0) return;
        if (x.ai.books[i].mention) x.ai.books.splice(i, 1);
        else delete x.ai.books[i].wanted;
      } else if (i >= 0) {
        const b = x.ai.books[i];
        b.wanted = Date.now();
        delete b.later;
        delete b.onShelf;
      } else {
        x.ai.books.push({
          title,
          author,
          title_uk: title,
          author_uk: author,
          lang: "",
          why: "",
          nonfiction: false,
          ...(href ? { href, cover: /^https:\/\//.test(m.cover || "") ? clean(m.cover, 500) : "", ctitle: title, cauthor: author, year: Number.isInteger(m.year) ? m.year : null } : {}),
          wanted: Date.now(),
          mention: clean(m.from, 200) || true,
        });
      }
      if (on) x.no = (x.no || []).filter((t) => fold(t) !== fold(title));
      x.touched = Date.now();
    });
  }
  // The reader's topics for a book's card: id, name, how many books, and the books added by hand (to show the topics
  // a book is in already). Cheap: no shelf, no notes.
  topics(acct) {
    const t = (x) => (x.status === "ok" && x.ai?.title && x.ai.kind !== "unclear" ? x.ai.title : x.text || "Фото");
    const at = (x) => Math.max(x.touched || 0, x.at || 0, ...(x.thoughts || []).map((y) => y.at || 0), ...Object.values(x.added || {}).map(Number).filter(Boolean), ...(x.ai?.books || []).map((b) => b.wanted || 0));
    return this.read(acct)
      .filter((x) => !(x.status === "ok" && x.ai?.kind === "unclear") && x.status !== "fail")
      .sort((a, b) => at(b) - at(a))
      .map((x) => {
        const added = (x.ai?.books || []).filter((b) => b.wanted);
        return { id: x.id, title: t(x), n: new Set([...(x.mine || []), ...(x.ai?.have || [])]).size + added.length + (x.ai?.shelf || []).length, books: added.map((b) => ({ t: b.title_uk || b.title, a: b.author_uk || b.author, href: b.href || "" })) };
      });
  }

  // One Opus call for the entry, then the catalog for its books. lib: the reader's own books [{ p, t, a }], so Opus
  // can name those that belong to the topic; none (a rerun after a restart) keeps the last answer's. shelf: the
  // account's shelf on the site [{ t, a, s, href, cover, year }] (index.js `siteShelf`), the same for its books on
  // it (`ai.shelf`); none keeps the last. more: «Порадити ще», new books past those suggested before (`seen`).
  async run(acct, id, lib = null, { shelf = null, more = false } = {}) {
    const key = `${acct}\t${id}`;
    if (this.running.has(key) || !this.apiKey) return;
    this.running.add(key);
    try {
      const it = this.read(acct).find((x) => x.id === id);
      if (!it) return;
      const t = Date.now();
      const content = [];
      if (it.photo) {
        try {
          content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(this.photoFile(acct, id)).toString("base64") } });
        } catch {}
      }
      const own = Array.isArray(lib) ? lib.filter((b) => b && typeof b.p === "string" && b.t).slice(0, LIB_MAX) : null;
      const site = Array.isArray(shelf) ? shelf.filter((b) => b && b.t).slice(0, SHELF_MAX) : null;
      // The reader's books first, as one block with its own cache mark: the same for every call of the next minutes.
      const lists = [
        own?.length ? `Книжки читача:\n${own.map((b, i) => `${i + 1}. ${clean(b.t, 150)}${b.a ? ` — ${clean(b.a, 100)}` : ""}`).join("\n")}` : "",
        site?.length ? `Полиця читача на Chytai:\n${site.map((b, i) => `${i + 1}. ${clean(b.t, 150)}${b.a ? ` — ${clean(b.a, 100)}` : ""} (${STATUS[b.s] ?? STATUS[""]})`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      if (lists) content.push({ type: "text", text: lists, cache_control: { type: "ephemeral" } });
      // What the reader did with the topic's books by hand (Max 2026-11-25, bot №56: «Порадити ще» should see the
      // books already in the topic, the declined ones and the thoughts): own books put in or taken out by hand
      // (`mine` / `notMine`, named from the library the page sent) and suggested ones added (`wanted`).
      const named = (t, a) => `${clean(t, 150)}${a ? ` — ${clean(a, 100)}` : ""}`;
      const ownName = (p) => {
        const b = own?.find((x) => x.p === p);
        return b ? named(b.t, b.a) : "";
      };
      const added = [...(it.mine || []).map(ownName), ...(it.ai?.books || []).filter((b) => b.wanted).map((b) => named(b.title_uk || b.title, b.author_uk || b.author))].filter(Boolean).slice(0, 40);
      const out = (it.notMine || []).map(ownName).filter(Boolean).slice(0, 40);
      const seen = more ? [...new Set([...(it.seen || []), ...(it.ai?.books || []).map((b) => b.title_uk || b.title)])].slice(-SEEN_MAX) : [];
      const words = [
        it.text ? `Запис читача: ${it.text}` : "Запис читача: лише фото.",
        it.voice ? "(надиктовано голосом, слова могли розпізнатися з помилками)" : "",
        ...(it.ask || []).map((a) => `Уточнення читача: ${a}`),
        ...(it.thoughts || []).slice(-10).map((t) => `Думка читача: ${t.text}`),
        seen.length ? `\nУже пропонували (назви інші книжки, 3–5): ${seen.map((t) => clean(t, 100)).join("; ")}` : "",
        it.no?.length ? `Читачеві не цікаві (не пропонуй їх): ${it.no.map((t) => clean(t, 100)).join("; ")}` : "",
        added.length ? `Читач сам додав у тему: ${added.join("; ")}` : "",
        out.length ? `Читач прибрав з теми (не про це): ${out.join("; ")}` : "",
      ].filter(Boolean).join("\n");
      content.push({ type: "text", text: words });
      const client = new Anthropic({ apiKey: this.apiKey });
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 3500,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      });
      const u = res.usage || {};
      this.spend(acct, measure(res.model || MODEL, u).cost);
      const raw = res.content.map((c) => c.text || "").join("");
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const books = (Array.isArray(j.books) ? j.books : []).slice(0, 5).map((b) => ({
        title: clean(b.title, 200),
        author: clean(b.author, 200),
        title_uk: clean(b.title_uk, 200),
        author_uk: clean(b.author_uk, 200),
        lang: clean(b.lang, 5).toLowerCase(),
        why: clean(b.why, 200),
        nonfiction: !!b.nonfiction,
      })).filter((b) => b.title || b.title_uk);
      const no = new Set((it.no || []).map(fold));
      for (let i = books.length - 1; i >= 0; i--) if (no.has(fold(books[i].title_uk || books[i].title)) || no.has(fold(books[i].title))) books.splice(i, 1);
      await Promise.all(books.map((b) => this.match(b)));
      const ai = {
        kind: KINDS.includes(j.kind) ? j.kind : "unclear",
        title: clean(j.title, 120),
        about: clean(j.about, 1200),
        books,
        guesses: (Array.isArray(j.guesses) ? j.guesses : []).map((g) => clean(g, 100)).filter(Boolean).slice(0, 3),
      };
      ai.have = own ? [...new Set((Array.isArray(j.have) ? j.have : []).map((n) => own[n - 1]?.p).filter(Boolean))].slice(0, 12) : it.ai?.have || [];
      // The site's books of the topic: Opus's picks, then a suggestion that is on the shelf after all (another
      // edition: the catalog page or the title before «, або» / «(» and an author's word) moves there.
      if (site) {
        const picked = [...new Set((Array.isArray(j.shelf) ? j.shelf : []).map((n) => site[n - 1]).filter(Boolean))];
        for (let i = books.length - 1; i >= 0; i--) {
          const s = onShelf(books[i], site);
          if (s) picked.push(s), books.splice(i, 1);
        }
        ai.shelf = [...new Map(picked.map((s) => [s.href || s.t, s])).values()].slice(0, 16).map((s) => ({ t: clean(s.t, 200), a: clean(s.a, 150), s: clean(s.s, 20), href: clean(s.href, 500), cover: clean(s.cover, 500), year: s.year || null }));
      } else ai.shelf = it.ai?.shelf || [];
      const reply = clean(j.reply, 600);
      // Books added to the topic stay added (with their time): marked again when Opus names them, else kept after.
      // The ones neither added nor declined go to «Раніше радили» (`later`) after «Порадити ще» (Max 2026-11-25: «в
      // другу чергу»), 30 at most, and stay there through later answers.
      // Merged with the entry as it is now, not as it was when asked: a book added meanwhile (a mentioned book put into
      // a new topic from its card) stays.
      this.update(acct, id, (x) => {
        let later = 0;
        for (const o of x.ai?.books || []) {
          const b = books.find((y) => fold(y.title) === fold(o.title));
          if (b) {
            if (o.wanted) b.wanted = o.wanted;
            if (o.mention) b.mention = o.mention;
          } else if (o.wanted) books.push(o);
          else if ((more || o.later) && later < 30) later++, books.push({ ...o, later: true });
        }
        if (more) (x.seen = seen), (x.touched = Date.now());
        x.ai = ai;
        x.status = "ok";
        x.ms = Date.now() - t;
        const th = x.replyTo && (x.thoughts || []).find((y) => y.id === x.replyTo);
        if (th && reply) th.reply = reply;
        delete x.replyTo;
      });
      this.log(`scratch ${acct.slice(0, 6)} ${id}: ${ai.kind} «${ai.title}», ${books.length} books (${books.filter((b) => b.href).length} in the catalog), ${Date.now() - t} ms`);
    } catch (err) {
      this.log(`scratch ${id}: ${err.message}`);
      this.update(acct, id, (x) => (x.status = "fail"));
    } finally {
      this.running.delete(key);
    }
  }

  // The catalog's page and cover for one book: its Ukrainian title first, then the original, by the same author.
  async match(b) {
    const names = [surname(b.author_uk), surname(b.author)].filter(Boolean);
    const tries = [b.title_uk && `${b.title_uk} ${b.author_uk}`, b.title && `${b.title} ${b.author}`, b.title_uk, b.title].filter(Boolean);
    for (const q of [...new Set(tries)]) {
      let found;
      try {
        found = (await this.find(q.slice(0, 100)))?.books || [];
      } catch {
        return;
      }
      const want = [fold(b.title_uk), fold(b.title)].filter(Boolean);
      const hit = found.find((h) => {
        const by = fold(h.author);
        const t = fold(h.title);
        return names.some((n) => by.split(" ").some((w) => near(w, n))) && want.some((w) => t.startsWith(w.split(" ").slice(0, 3).join(" ")) || w.startsWith(t.split(" ").slice(0, 3).join(" ")));
      });
      if (hit) {
        Object.assign(b, { href: hit.href, cover: hit.cover || "", ctitle: hit.title, cauthor: hit.author, year: hit.year || null });
        return;
      }
    }
  }
}

module.exports = { Scratch, MODEL, SYSTEM };
