// «Полиці» (Max 2026-11-27, variant A of canvas H7RtPE5ytNgCN2uEt22xD7): paper books that stand somewhere, at home,
// in an office, at a friend's. A reader makes a shelf from photos of it (Sonnet reads the spines) or a pasted list
// (Haiku parses it), each title found in the catalog; then shares it by a link (/p/<key>). Another reader who opens
// the link adds the shelf («Стежити») and sees in «Хочу прочитати» which wanted books stand on it («Полиці
// друзів»). They talk outside the app: no messages here, no contacts shown. A shelf is seen only by its link; its
// owner sees who added it and can take a reader off or make a new link (the old one stops working).
// Kept per account in accounts/<id>/shelves.json: { mine: [{ id, name, key, books: [{ t, a, h, c }], seen: { acct:
// at }, at }], follows: [{ o, id, at }] }, gone with the account; keys in DATA_DIR/shelf-keys.json ({ key: [acct,
// id] }), a key whose shelf is gone is dropped when asked.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { measure } = require("./aimeter");

const PHOTO_MODEL = "claude-sonnet-5-5";
const LIST_MODEL = "claude-haiku-5-5";
const SHELVES_MAX = 20; // shelves an account makes
const BOOKS_MAX = 1000; // books on a shelf
const FOLLOWS_MAX = 100; // shelves an account adds
const SEEN_MAX = 200; // readers who added one shelf
const LIST_MAX = 300; // lines of a pasted list read at once
const NAME_MAX = 40;
const ABOUT_MAX = 1000; // the owner's own words under the name (Max 2026-11-28: whether they lend books, anything)
const RETRY_MS = 30 * 24 * 3600 * 1000; // a book no catalog had is looked for again after a month

const PHOTO_PROMPT = `This is a photo of books standing on a shelf or lying in a pile: spines, sometimes covers. List every book whose title you can read.
For each: the title and the author as printed (keep the language and spelling; on a Ukrainian spine the author's surname is often printed alone, give it as printed). Leave out series names, publishers and slogans. Never guess a title you cannot read; leave out a book you can't read.
Answer with JSON only: {"books": [{"title": "...", "author": "..."}]}, left to right, top shelf first. No books readable: {"books": []}.`;

const LIST_PROMPT = `The text below is a list of books a reader pasted (made by hand, copied from a note or written by ChatGPT). Pick out every book in it: its title and author as written (keep the language and spelling; no numbering, quotes, years, comments or publisher). Leave out lines that are not a book (headings, remarks). A line with only a title: author "".
Answer with JSON only: {"books": [{"title": "...", "author": "..."}]}, in the list's order.

The list:
`;

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[’ʼ'`"«»“”„.,:;!?()\[\]–—-]/g, " ").replace(/\s+/g, " ").trim();
// A book's key apart from the catalog: its title before «:»/«.»/«(» and the author's surname (the last word).
const bookKey = (t, a) => `${norm(String(t || "").split(/[:(]|\.\s/)[0])}|${norm(a).split(" ").filter(Boolean).pop() || ""}`;
const pathOf = (href) => String(href || "").replace(/^https?:\/\/[^/]+/, "");

class Shelves {
  constructor({ dir, dataDir, apiKey, find }) {
    this.dir = dir;
    this.keysFile = path.join(dataDir, "shelf-keys.json");
    this.apiKey = apiKey;
    this.find = find;
    try {
      this.keys = JSON.parse(fs.readFileSync(this.keysFile, "utf8"));
    } catch {
      this.keys = {};
    }
  }
  file(acct) {
    return path.join(this.dir, acct, "shelves.json");
  }
  load(acct) {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(acct), "utf8"));
      return { mine: d.mine || [], follows: d.follows || [] };
    } catch {
      return { mine: [], follows: [] };
    }
  }
  save(acct, d) {
    const f = this.file(acct);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(d));
    fs.renameSync(`${f}.tmp`, f);
  }
  saveKeys() {
    fs.writeFileSync(`${this.keysFile}.tmp`, JSON.stringify(this.keys));
    fs.renameSync(`${this.keysFile}.tmp`, this.keysFile);
  }
  own(acct, id) {
    const d = this.load(acct);
    return { d, s: d.mine.find((x) => x.id === id) || null };
  }

  create(acct, name) {
    const d = this.load(acct);
    if (d.mine.length >= SHELVES_MAX) throw Object.assign(new Error(`Полиць може бути до ${SHELVES_MAX}.`), { status: 400 });
    const s = { id: crypto.randomBytes(5).toString("hex"), name: clean(name, NAME_MAX) || "Полиця", key: "", books: [], seen: {}, at: Date.now() };
    d.mine.push(s);
    this.save(acct, d);
    return s;
  }
  // Rename, the owner's words, add books (a catalog page or title + author once), take some off by index.
  // drop: places in the list; dropBooks: [{ t, a, h }] the books themselves (a change queued offline, web-bridge.js,
  // may come after the list changed on another device), these win when given.
  change(acct, id, { name, about, add, drop, dropBooks } = {}) {
    const { d, s } = this.own(acct, id);
    if (!s) return null;
    if (name != null && clean(name, NAME_MAX)) s.name = clean(name, NAME_MAX);
    if (about != null) s.about = String(about).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, ABOUT_MAX);
    const was = s.books.length;
    if (Array.isArray(dropBooks) && dropBooks.length) {
      const off = new Set(dropBooks.map((x) => (x?.h ? pathOf(x.h) : bookKey(x?.t, x?.a))));
      s.books = s.books.filter((b) => !off.has(b.h ? pathOf(b.h) : bookKey(b.t, b.a)));
    } else if (Array.isArray(drop) && drop.length) {
      const off = new Set(drop.map(Number));
      s.books = s.books.filter((_, i) => !off.has(i));
    }
    if (Array.isArray(add)) {
      const have = new Set(s.books.map((b) => (b.h ? pathOf(b.h) : bookKey(b.t, b.a))));
      for (const x of add) {
        const b = { t: clean(x?.t, 200), a: clean(x?.a, 150), h: /^https?:\/\//.test(x?.h || "") ? clean(x.h, 300) : "", c: /^https?:\/\//.test(x?.c || "") ? clean(x.c, 500) : "" };
        const k = b.h ? pathOf(b.h) : bookKey(b.t, b.a);
        if (!b.t || have.has(k) || s.books.length >= BOOKS_MAX) continue;
        have.add(k);
        s.books.push(b);
      }
    }
    s.edited = Date.now();
    this.save(acct, d);
    return { shelf: s, added: s.books.length - was };
  }
  remove(acct, id) {
    const { d, s } = this.own(acct, id);
    if (!s) return false;
    if (s.key) delete this.keys[s.key], this.saveKeys();
    d.mine = d.mine.filter((x) => x !== s);
    this.save(acct, d);
    return true;
  }
  // The shelf's link: its key, a new one with `fresh` (the old link stops working; who added it keeps it).
  share(acct, id, fresh = false) {
    const { d, s } = this.own(acct, id);
    if (!s) return null;
    if (s.key && !fresh) return s.key;
    if (s.key) delete this.keys[s.key];
    s.key = crypto.randomBytes(8).toString("base64url").replace(/[-_]/g, "").slice(0, 10).toLowerCase() || crypto.randomBytes(5).toString("hex");
    this.keys[s.key] = [acct, id];
    this.saveKeys();
    this.save(acct, d);
    return s.key;
  }
  // Take one reader off the shelf: it leaves their «Полиці», and their «Хочу прочитати».
  kick(acct, id, who) {
    const { d, s } = this.own(acct, id);
    if (!s || !s.seen?.[who]) return false;
    delete s.seen[who];
    this.save(acct, d);
    const f = this.load(who);
    f.follows = f.follows.filter((x) => !(x.o === acct && x.id === id));
    this.save(who, f);
    return true;
  }
  // The shelf a link opens: { o, id, shelf }, or null (no such key, or the shelf is gone).
  open(key) {
    const k = this.keys[String(key || "").toLowerCase()];
    if (!k) return null;
    const { s } = this.own(k[0], k[1]);
    if (!s || s.key !== String(key).toLowerCase()) {
      delete this.keys[key];
      this.saveKeys();
      return null;
    }
    return { o: k[0], id: k[1], shelf: s };
  }
  follow(acct, key) {
    const hit = this.open(key);
    if (!hit) return null;
    if (hit.o === acct) return { ...hit, own: true };
    const f = this.load(acct);
    if (f.follows.some((x) => x.o === hit.o && x.id === hit.id)) return { ...hit, already: true };
    if (f.follows.length >= FOLLOWS_MAX) throw Object.assign(new Error(`Полиць друзів може бути до ${FOLLOWS_MAX}.`), { status: 400 });
    const { d, s } = this.own(hit.o, hit.id);
    if (Object.keys(s.seen || {}).length >= SEEN_MAX) throw Object.assign(new Error("Цю полицю вже додали забагато людей."), { status: 400 });
    (s.seen ??= {})[acct] = Date.now();
    this.save(hit.o, d);
    f.follows.push({ o: hit.o, id: hit.id, at: Date.now() });
    this.save(acct, f);
    return { ...hit, shelf: s };
  }
  unfollow(acct, o, id) {
    const f = this.load(acct);
    f.follows = f.follows.filter((x) => !(x.o === o && x.id === id));
    this.save(acct, f);
    const { d, s } = this.own(o, id);
    if (s?.seen?.[acct]) delete s.seen[acct], this.save(o, d);
  }
  // The shelves an account added that it may still see: [{ o, id, shelf }]; gone ones and ones it was taken off go.
  followed(acct) {
    const f = this.load(acct);
    const out = [];
    for (const x of f.follows) {
      const { s } = this.own(x.o, x.id);
      if (s && s.seen?.[acct]) out.push({ o: x.o, id: x.id, shelf: s });
    }
    if (out.length !== f.follows.length) (f.follows = out.map((x) => f.follows.find((y) => y.o === x.o && y.id === x.id))), this.save(acct, f);
    return out;
  }
  // One followed shelf, only for a reader on it.
  friend(acct, o, id) {
    const { s } = this.own(o, id);
    return s && s.seen?.[acct] ? s : null;
  }
  // Which followed shelves hold a book: an index of the account's followed shelves by catalog page and by title.
  index(acct, nameOf) {
    const byPath = new Map();
    const byKey = new Map();
    for (const { o, id, shelf } of this.followed(acct)) {
      const ref = { who: nameOf(o), name: shelf.name, o, id };
      for (const b of shelf.books) {
        if (b.h) (byPath.get(pathOf(b.h)) || byPath.set(pathOf(b.h), []).get(pathOf(b.h))).push(ref);
        const k = bookKey(b.t, b.a);
        (byKey.get(k) || byKey.set(k, []).get(k)).push(ref);
      }
    }
    // A want book (with its other versions) -> the shelves it stands on, each once.
    return (b) => {
      if (!byPath.size && !byKey.size) return [];
      const refs = [b, ...(b.other || [])].flatMap((v) => [...(byPath.get(pathOf(v.href)) || []), ...(byKey.get(bookKey(v.title, v.author)) || [])]);
      return refs.filter((r, i) => refs.findIndex((x) => x.o === r.o && x.id === r.id) === i).map(({ who, name, o, id }) => ({ who, name, o, id }));
    };
  }

  // ——— books the catalog lacked, added to it later (server/index.js `shelfFill`, the site's /api/reader-shelfbooks) ———
  // An own shelf's books with no catalog page, not asked about in the last month: [{ id, k, t, a }], `n` at most.
  waiting(acct, n = 5) {
    const out = [];
    const now = Date.now();
    for (const s of this.load(acct).mine)
      for (const b of s.books) {
        if (out.length >= n) return out;
        if (!b.h && !(now - (b.q || 0) < RETRY_MS)) out.push({ id: s.id, k: bookKey(b.t, b.a), t: b.t, a: b.a });
      }
    return out;
  }
  // The site's answers: a found book takes its page and cover (once on a shelf: a second copy goes); `none` = asked.
  filled(acct, answers) {
    const d = this.load(acct);
    let n = 0;
    for (const { id, k, r } of answers) {
      const s = d.mine.find((x) => x.id === id);
      const b = s?.books.find((x) => !x.h && bookKey(x.t, x.a) === k);
      if (!b || !r || r.wait) continue;
      if (r.href) {
        if (s.books.some((x) => x.h && pathOf(x.h) === pathOf(r.href))) {
          s.books = s.books.filter((x) => x !== b);
          continue;
        }
        Object.assign(b, { h: clean(r.href, 300), c: /^https?:\/\//.test(r.cover || "") ? clean(r.cover, 500) : b.c, t: clean(r.title, 200) || b.t, a: clean(r.author, 150) || b.a });
        delete b.q;
        n++;
      } else b.q = Date.now();
    }
    this.save(acct, d);
    return n;
  }
  // How many own-shelf books wait for the catalog, were not found, and are in it: for /agent/shelf-fill.
  tally(acct) {
    const t = { books: 0, catalog: 0, waiting: 0, notFound: 0 };
    const now = Date.now();
    for (const s of this.load(acct).mine)
      for (const b of s.books) {
        t.books++;
        if (b.h) t.catalog++;
        else if (now - (b.q || 0) < RETRY_MS) t.notFound++;
        else t.waiting++;
      }
    return t;
  }

  // ——— reading a photo or a list ———
  async ask(model, content, maxTokens) {
    const client = new Anthropic({ apiKey: this.apiKey });
    const msg = await client.messages.create({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] });
    const raw = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    let books = [];
    try {
      books = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).books || [];
    } catch {}
    return {
      books: books.map((b) => ({ title: clean(b?.title, 200), author: clean(b?.author, 150) })).filter((b) => b.title.length > 1),
      cost: measure(msg.model || model, msg.usage || {}).cost,
    };
  }
  readPhoto(image, mediaType) {
    return this.ask(PHOTO_MODEL, [{ type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } }, { type: "text", text: PHOTO_PROMPT }], 4000);
  }
  readList(text) {
    const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, LIST_MAX).join("\n");
    return this.ask(LIST_MODEL, LIST_PROMPT + lines.slice(0, 30000), 8000);
  }
  // Each read title in the catalog: the search's first book whose title shares the read one's first word, by the
  // title with the author and then the title alone; else the book as read (`miss`). Five at a time.
  async match(list) {
    // The read title's words (before «:») all in the found one, whole; and the found one's own head mostly in the read
    // title, or by the same author: «The Pragmatic Programmer» is not «Programming Ruby: The Pragmatic Programmers' Guide».
    const words = (t) => norm(t).split(" ").filter((w) => w.length > 2 || /\d/.test(w));
    const surname = (a) => norm(a).split(" ").filter(Boolean).pop()?.slice(0, 4) || "";
    const fits = (hit, b) => {
      if (!hit) return false;
      const read = words(String(b.title).split(":")[0]);
      const all = new Set(words(hit.title));
      if (!read.length || !read.every((w) => all.has(w))) return false;
      const head = words(String(hit.title).split(/:|\.\s/)[0]);
      const mine = new Set(words(b.title));
      return head.filter((w) => mine.has(w)).length * 2 >= head.length || (!!surname(b.author) && norm(hit.author).includes(surname(b.author)));
    };
    const one = async (b) => {
      let hit = null;
      try {
        hit = ((await this.find(`${b.title} ${b.author}`.trim().slice(0, 100))).books || []).find((x) => fits(x, b));
        // By the title alone only a book by the same author: «Сад» finds many.
        const sur = surname(b.author);
        if (!hit && sur) hit = ((await this.find(b.title.slice(0, 100))).books || []).find((x) => fits(x, b) && norm(x.author).includes(sur));
      } catch {}
      return hit ? { t: hit.title, a: hit.author || b.author, h: hit.href, c: hit.cover || "" } : { t: b.title, a: b.author, h: "", c: "", miss: true };
    };
    const out = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await one(list[i]);
      }
    }));
    // The same book read twice (two photos of one shelf) once.
    const seen = new Set();
    return out.filter((b) => {
      const k = b.h ? pathOf(b.h) : bookKey(b.t, b.a);
      return !seen.has(k) && seen.add(k);
    });
  }
}

module.exports = { Shelves, bookKey, pathOf };
