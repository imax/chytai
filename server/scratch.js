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
- guesses: only for "unclear": 2–3 short Ukrainian guesses of what was meant (an author and a book, a topic), each at most 8 words; otherwise an empty list. For "unclear" leave books empty and about empty.

- have: the numbers of the reader's own books (the list after «Книжки читача:», when there is one) that clearly belong to this subject, read or not; at most 12; an empty list when none or no list.
- reply: only when the request has «Думка читача:» lines: one or two short Ukrainian sentences on the LAST thought: where to dig next (a book from your list, an angle, a question worth looking into). No «ви», no praise. Otherwise an empty string.

Rules: never recommend Russian authors or Russian-language editions; prefer books that exist in Ukrainian when they are as good. Name only real books you are sure exist. Answer only with the JSON.

A photo may show a book cover, a page, a poster, a screen with a podcast or an article: the subject is what the reader would want to read about from it. Lines after «Уточнення читача:» and «Думка читача:» are the reader's later words: follow them (a guess they picked, «щось українською», «тільки нонфікшн», a question the reader wants to dig into) and answer the whole entry anew, the books too.`;

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
    reply: { type: "string" },
  },
  required: ["kind", "title", "about", "books", "guesses", "have", "reply"],
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
  // One of the reader's books put into the topic by hand, or taken out of it.
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
      x.touched = Date.now();
    });
  }
  // A book Opus suggested put on «Хочу прочитати» (the site's shelf): remembered here so the topic shows it at once.
  wanted(acct, id, i) {
    return this.update(acct, id, (x) => {
      const b = x.ai?.books?.[i];
      if (b) (b.wanted = true), (x.touched = Date.now());
    });
  }

  // One Opus call for the entry, then the catalog for its books. lib: the reader's own books [{ p, t, a }], so Opus
  // can name those that belong to the topic; none (a rerun after a restart) keeps the last answer's.
  async run(acct, id, lib = null) {
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
      const words = [
        it.text ? `Запис читача: ${it.text}` : "Запис читача: лише фото.",
        it.voice ? "(надиктовано голосом, слова могли розпізнатися з помилками)" : "",
        ...(it.ask || []).map((a) => `Уточнення читача: ${a}`),
        ...(it.thoughts || []).slice(-10).map((t) => `Думка читача: ${t.text}`),
        own?.length ? `\nКнижки читача:\n${own.map((b, i) => `${i + 1}. ${clean(b.t, 150)}${b.a ? ` — ${clean(b.a, 100)}` : ""}`).join("\n")}` : "",
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
      await Promise.all(books.map((b) => this.match(b)));
      const ai = {
        kind: KINDS.includes(j.kind) ? j.kind : "unclear",
        title: clean(j.title, 120),
        about: clean(j.about, 1200),
        books,
        guesses: (Array.isArray(j.guesses) ? j.guesses : []).map((g) => clean(g, 100)).filter(Boolean).slice(0, 3),
      };
      ai.have = own ? [...new Set((Array.isArray(j.have) ? j.have : []).map((n) => own[n - 1]?.p).filter(Boolean))].slice(0, 12) : it.ai?.have || [];
      const reply = clean(j.reply, 600);
      // Books put on «Хочу прочитати» from this topic stay marked when Opus names them again.
      const was = new Set((it.ai?.books || []).filter((b) => b.wanted).map((b) => fold(b.title)));
      for (const b of books) if (was.has(fold(b.title))) b.wanted = true;
      this.update(acct, id, (x) => {
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
