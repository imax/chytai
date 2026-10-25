// «Книжка з вашого «Хочу прочитати» тепер є» (Max, 2026-10-25: «якщо книжка у когось в Хочу і вона зʼявилась в
// продажу, чи ми про це якось повідомляємо?»; he chose a letter of its own over a line in the Friday digest).
// Once a day, from the catalogs we already have (no library lookups, no AI), each reader's «хочу» books are
// checked for three things: a shop or publisher has it in stock (`sale`), there is a Ukrainian edition (`uk`,
// for a book wanted in another language), it is on the reader's «Вільна полиця» (`free`). What a book already
// had when it was first checked is its baseline and is never written about; each of the three is written about
// once per reader and book, ever, so a shop running out and back does not bring a second letter. No prices,
// no shop links: the letter points at the book page. One letter a day at most, with every book in it.
// Switch: readers.want_mail (/settings/mail), one-click unsubscribe with the digest's signed token.
const { isRussian } = require("./store");

const SEND_HOUR = 10; // Kyiv time, after the night's catalog refresh
const MAX_BOOKS = 10;
const KINDS = ["uk", "sale", "free"];

const kyiv = (d) => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
const dayKyiv = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const ukrainian = (it) => (/^(uk|укр)/i.test(it.language || "") || (!it.language && /[а-яіїєґ]/i.test(it.title || ""))) && !isRussian(it);

class WantMail {
  constructor({ store, auth, digest, site, log = console.log, to = "all", ownerId = "owner" }) {
    this.store = store;
    this.auth = auth;
    this.digest = digest; // its signed per-reader token, for the unsubscribe link
    this.site = site;
    this.log = log;
    this.to = to;
    this.ownerId = ownerId;
    this.running = null;
  }

  enabled(readerId) {
    const r = this.auth.reader(readerId);
    return !!r && r.want_mail !== 0;
  }
  setEnabled(readerId, on) {
    this.store.db.prepare("UPDATE readers SET want_mail = ? WHERE id = ?").run(on ? 1 : 0, readerId);
  }
  unsubscribeUrl(readerId) {
    return `${this.site}/want-mail/unsubscribe/${encodeURIComponent(readerId)}/${this.digest.token(readerId)}`;
  }

  // Every catalog edition of the work and of its translations, on shelves the site shows.
  items(id) {
    const s = this.store;
    const out = [];
    for (const w of [id, ...(s.translations?.get(id) || [])]) {
      const eds = s.editions.get(w) || [s.shelfItems.get(w)].filter(Boolean);
      for (const si of eds) if (!si.shelf.draft && !s.hidden.has(si.item.id) && !isRussian(si.item)) out.push({ ...si, work: w });
    }
    return out;
  }

  // What the book has now: { kind: the edition that shows it }.
  has(id) {
    const s = this.store;
    const own = s.book(id, { edited: false, borrow: false });
    const out = {};
    for (const si of this.items(id)) {
      const { shelf, item } = si;
      if (!out.free && shelf.kind === "free") out.free = si;
      if (!out.sale && (shelf.kind === "publisher" || shelf.kind === "audio") && item.status === "є") out.sale = si;
      // A Ukrainian edition counts only for a book wanted in another language.
      if (!out.uk && own && !ukrainian(own) && ukrainian(item)) out.uk = si;
    }
    return out;
  }

  // The books to write a reader about, with the state to keep once the letter is out. A book seen for the
  // first time only records what it has.
  build(readerId, { now = new Date() } = {}) {
    const db = this.store.db;
    const rows = new Map(db.prepare("SELECT book, had FROM want_mail WHERE reader = ?").all(readerId).map((r) => [r.book, new Set(JSON.parse(r.had))]));
    const wanted = new Set(db.prepare("SELECT book FROM entries WHERE reader = ? AND status = 'want'").all(readerId).map((r) => this.store.canonical(r.book)));
    const books = [];
    const state = [];
    for (const id of wanted) {
      if (!this.store.isWork(id)) continue;
      const has = this.has(id);
      const had = rows.get(id);
      const kinds = KINDS.filter((k) => has[k]);
      if (!had) {
        state.push([id, kinds]);
        continue;
      }
      const fresh = kinds.filter((k) => !had.has(k));
      if (!fresh.length) continue;
      state.push([id, [...had, ...fresh]]);
      const b = this.store.book(id);
      if (b && !isRussian(b)) books.push({ id, book: b, news: fresh.map((k) => ({ kind: k, ...has[k], href: has[k].work !== id ? this.store.href(has[k].work) : "" })) });
    }
    return { books, state, at: now.toISOString() };
  }

  save(readerId, state, at) {
    const up = this.store.db.prepare("INSERT INTO want_mail (reader, book, had, at) VALUES (?, ?, ?, ?) ON CONFLICT (reader, book) DO UPDATE SET had = excluded.had, at = excluded.at");
    this.store.db.tx(() => state.forEach(([id, kinds]) => up.run(readerId, id, JSON.stringify(kinds), at)));
  }

  line({ kind, shelf, item, work }, id) {
    const other = work !== id ? ` «${item.title}»` : "";
    if (kind === "free") return `можна читати безкоштовно в Читалці${other}`;
    if (kind === "uk" && item.status === "анонс") return `анонсували українською${other} (${shelf.name}${item.expected ? `, орієнтовно ${item.expected.toLowerCase()}` : ""})`;
    if (kind === "uk") return `є українською${other} (${shelf.name}${item.status === "передзамовлення" ? ", передзамовлення" : ""})`;
    return `${item.format === "аудіо" ? "є аудіокнига" : "є в продажу"}${other} (${shelf.name})`;
  }

  render(reader, books) {
    const site = this.site;
    const shown = books.slice(0, MAX_BOOKS);
    const one = books.length === 1 && books[0];
    const k = one && one.news[0].kind;
    const subject = one ? `«${one.book.title}» ${k === "free" ? "тепер можна читати безкоштовно" : k === "uk" ? (one.news[0].item.status === "анонс" ? "виходить українською" : "тепер є українською") : "тепер є в продажу"}` : `Книжки з вашого «Хочу прочитати» тепер є (${books.length})`;
    const off = this.unsubscribeUrl(reader.id);
    const text = [
      one ? `Книжка з вашого «Хочу прочитати» на Chytai:` : `Книжки з вашого «Хочу прочитати» на Chytai:`,
      ``,
      ...shown.flatMap((x) => [`${x.book.title}${x.book.author ? ` — ${x.book.author}` : ""}`, ...x.news.map((n) => `  ${this.line(n, x.id)}`), `  ${site}${x.news.find((n) => n.href)?.href || x.book.href}`, ``]),
      ...(books.length > shown.length ? [`І ще ${books.length - shown.length}: ${site}/@${reader.username}`, ``] : []),
      `Відписатися від цих листів: ${off}`,
    ];
    return { to: reader.email, subject, text: text.join("\n"), headers: { "List-Unsubscribe": `<${off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }

  recipients() {
    return this.auth.readers().filter((r) => r.email && r.want_mail !== 0 && (this.to === "all" || r.id === this.ownerId));
  }

  // The letter a reader would get now, without sending or recording it (/want-mail/preview).
  preview(reader) {
    const d = this.build(reader.id);
    return d.books.length ? this.render(reader, d.books) : null;
  }

  // The daily run. A reader's state is saved only once their letter is accepted (or when there is nothing to
  // send), so a run cut by a deploy just goes on the next time without a second letter.
  async run({ now = new Date() } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const out = { started: now.toISOString(), sent: 0, readers: 0, errors: [] };
      for (const r of this.recipients()) {
        try {
          const d = this.build(r.id, { now });
          out.readers++;
          if (d.books.length) {
            const l = this.render(r, d.books);
            await this.auth.send(l.to, l.subject, l.text, { headers: l.headers });
            out.sent++;
            this.log(`want mail @${r.username}: «${l.subject}»`);
          }
          if (d.state.length) this.save(r.id, d.state, d.at);
        } catch (e) {
          out.errors.push(`@${r.username}: ${e.message}`);
          this.log(`want mail @${r.username} failed: ${e.message}`);
        }
      }
      out.finished = new Date().toISOString();
      this.store.db.set("wantmail:last", JSON.stringify(out));
      return out;
    })().finally(() => (this.running = null));
    return this.running;
  }

  // Once a day from 10:00 Kyiv, checked every ten minutes; not while the Friday letter is going out.
  schedule() {
    const tick = () => {
      const db = this.store.db;
      const today = dayKyiv(new Date());
      if (kyiv(new Date()).getHours() < SEND_HOUR || db.get("wantmail:lastRun") === today || db.get("digest:running")) return;
      db.set("wantmail:lastRun", today);
      this.run().catch((e) => this.log(`want mail run failed: ${e.message}`));
    };
    setInterval(tick, 10 * 60 * 1000).unref();
    setTimeout(tick, 2 * 60 * 1000).unref();
  }
}

module.exports = { WantMail };
