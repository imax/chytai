// The new books' checks (Max, 2026-10-27: «додавання нової книжки … теж має запускати певні перевірки?
// дублі, чистка метаданих, пошук обкладинки», «можливо нам треба саме черга, а не просто розклад»). Every
// book that comes in, a reader's (by hand, an import, a chat, «Уся серія», a Ukrainian edition) or a
// catalog's (the refresh), waits in `book_queue` (store.queueBooks), and the jobs process takes a batch
// every few minutes instead of leaving it to the six-hour passes:
//   1. details and the cover from Readeat and Open Library, for readers' own books (the site asks at once
//      too; a book asked within the month is skipped);
//   2. the language of a doubtful Cyrillic title (Haiku): a Russian book stops here, hidden;
//   3. genres and the original of a translation (Haiku);
//   4. the catalog passes already applied on the whole catalog (dupes, not-books, covers, years…), only
//      for these books;
//   5. an Open Library cover kept here, and the small copies made.
// Each step's answer is kept per book for /admin/jobs. The Haiku steps wait for their whole-catalog run to
// have finished, like the six-hour schedule, which stays to catch what this missed.
const { isRussian } = require("./store");

const BATCH = 60;
const WAIT = 2 * 60 * 1000; // the site's own details lookup goes first
const DAILY = 1500; // books a day at most: a new catalog of thousands goes over a few days
const KEEP = 30 * 24 * 3600 * 1000;

class NewBooks {
  constructor({ store, db, details, lang, genre, orig, passes = [], keepCovers, warm, busy = () => false, log = console.log }) {
    Object.assign(this, { store, db, details, lang, genre, orig, passes, keepCovers, warm, busy, log });
    this.running = false;
  }

  async run() {
    if (this.running || this.busy()) return null;
    const db = this.db;
    const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const done = db.prepare("SELECT count(*) AS n FROM book_queue WHERE done >= ?").get(today).n;
    if (done >= DAILY) return null;
    const rows = db.prepare("SELECT id, source FROM book_queue WHERE done IS NULL AND added <= ? ORDER BY added LIMIT ?").all(new Date(Date.now() - WAIT).toISOString(), Math.min(BATCH, DAILY - done));
    if (!rows.length) return null;
    this.running = true;
    const store = this.store;
    const out = { books: rows.length, haiku: 0, ru: 0, cost: 0, errors: 0 };
    const steps = new Map(rows.map((r) => [r.id, {}]));
    let own = [];
    const fail = (st, k, e) => ((st[k] = `✗ ${String(e?.message || e).slice(0, 120)}`), out.errors++);
    try {
      // This process read the data at its start: the books the site added since are read again.
      if (rows.some((r) => !store.book(r.id))) store.fresh();
      own = rows.map((r) => r.id).filter((id) => store.lib.books[id]);
      if (own.length)
        try {
          await this.details({ ids: own });
        } catch (e) {
          for (const id of own) fail(steps.get(id), "details", e);
        }
      const ids = new Set();
      let origs = 0;
      for (const r of rows) {
        const st = steps.get(r.id);
        const id = store.canonical(r.id);
        if (!store.book(id)) {
          st.gone = true; // merged away or deleted before its turn
          continue;
        }
        if (id !== r.id) st.work = id; // an edition of a book the site has
        ids.add(r.id).add(id);
        let cost = 0;
        for (const [k, t] of [["lang", this.lang], ["genre", this.genre], ["orig", this.orig]]) {
          if (k !== "lang" && isRussian(store.book(id))) {
            st.ru = true;
            out.ru++;
            break;
          }
          try {
            const a = await t?.one(store.book(id));
            if (!a) continue;
            st[k] = a.answer;
            cost += a.cost;
            out.haiku++;
            if (k === "orig") origs++;
          } catch (e) {
            fail(st, k, e);
          }
        }
        st.cost = cost;
        out.cost += cost;
      }
      if (origs) store.linkTranslations();
      if (out.haiku) store.indexSearch();
      // The passes answer about groups of books (dupes) as much as about one, so their result is the batch's.
      const passes = {};
      for (const p of this.passes)
        try {
          const r = await p.runFor(ids);
          if (!r) continue;
          passes[p.key] = `${r.asked} спитали, ${r.applied} змінили${r.errors ? `, ${r.errors} ✗` : ""}`;
          out.cost += r.cost;
          out.errors += r.errors;
        } catch (e) {
          passes[p.key] = `✗ ${e.message}`;
          out.errors++;
        }
      if (Object.keys(passes).length) out.passes = Object.entries(passes).map(([k, v]) => `${k}: ${v}`).join("; ");
      try {
        const kept = await this.keepCovers([...ids]);
        if (kept) out.covers = kept;
        await this.warm([...ids].map((id) => store.book(id)?.cover).filter(Boolean));
      } catch (e) {
        out.errors++;
        this.log(`new books: covers: ${e.message}`);
      }
    } finally {
      const at = new Date().toISOString();
      const put = db.prepare("UPDATE book_queue SET done = ?, steps = ?, cost = ? WHERE id = ?");
      for (const r of rows) {
        const { cost = 0, ...st } = steps.get(r.id);
        put.run(at, JSON.stringify(st), cost, r.id);
      }
      db.prepare("DELETE FROM book_queue WHERE done < ?").run(new Date(Date.now() - KEEP).toISOString());
      this.running = false;
    }
    out.cost = Math.round(out.cost * 10000) / 10000;
    // The site reloads (jobs.js) only when something it shows may have changed.
    out.changed = !!(out.haiku || out.covers || out.passes || own.length);
    out.note = [`книжок ${out.books}`, `Haiku ${out.haiku}`, out.ru ? `російських ${out.ru}` : "", out.covers ? `обкладинок ${out.covers}` : "", out.passes || "", `$${out.cost}`, out.errors ? `помилок ${out.errors}` : ""].filter(Boolean).join(", ");
    this.log(`new books: ${out.books} checked, ${out.haiku} Haiku answers, ${out.ru} Russian, $${out.cost}${out.errors ? `, ${out.errors} errors` : ""}`);
    return out;
  }

  // For /admin/jobs: what waits, what went through, the latest books with each step's answer.
  overview() {
    const db = this.db;
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const waiting = db.prepare("SELECT count(*) AS n, min(added) AS oldest FROM book_queue WHERE done IS NULL").get();
    const sum = (since) => db.prepare("SELECT count(*) AS n, coalesce(sum(cost), 0) AS cost, sum(steps LIKE '%✗%') AS failed FROM book_queue WHERE done >= ?").get(since);
    const bySource = db.prepare("SELECT source, count(*) AS n FROM book_queue WHERE added >= ? GROUP BY source ORDER BY n DESC").all(week);
    const latest = db.prepare("SELECT id, source, added, done, steps FROM book_queue WHERE done IS NOT NULL ORDER BY done DESC, added DESC LIMIT 30").all().map((r) => ({ ...r, steps: JSON.parse(r.steps || "{}") }));
    return { waiting: waiting.n, oldest: waiting.oldest, day: sum(day), week: sum(week), bySource, latest };
  }
}

module.exports = { NewBooks, BATCH, DAILY };
