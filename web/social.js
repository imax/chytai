// What readers do with books, for the pages of the 2026-10-20 design: a book's rating across readers,
// the activity feed («Зараз читають», «Стрічка»), «Книжка навмання» and «схожі» recommendations.
// Everything is computed from the entries in memory (store.entries); there are few readers yet.
// Books in Russian are left out of all of it (store.js isRussian).
//
// `who(readerId)` turns a reader id into the public reader ({ name, href, ... }) or null.

// Tags that say nothing about what a book is like.
const { isRussian } = require("./store");
const PLAIN = new Set(["українською"]);
const tagsOf = (b) => (b?.tags || []).filter((t) => !PLAIN.has(t));
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

class Social {
  constructor(store, who) {
    this.store = store;
    this.who = who;
  }

  // Every entry of every reader that has something to say (a status or a rating): [{ reader, id, entry }].
  // «Покинуто» never is: no feed line, no rating counted, nothing in the letters.
  // Kept until the current request is done: a page asks for it many times (/community once per reader), and
  // each time looks up every reader's every book (2.2 s for /community on 2026-10-21).
  all() {
    if (this.cached) return this.cached;
    const out = (this.cached = []);
    setImmediate(() => (this.cached = null));
    for (const [rid, entries] of this.store.entries) {
      const reader = this.who(rid);
      if (!reader) continue;
      for (const [id, e] of Object.entries(entries)) if ((e.status || e.rating != null) && e.status !== "abandoned" && !isRussian(this.store.book(id))) out.push({ reader, id, entry: e });
    }
    return out;
  }

  // A book across readers: the mean rating, how many rated it, want it and have it at all; how many
  // finished it and how many gave up on it (Max, 2026-10-21: like YouTube's dislikes, the ratio says
  // something about a book; only the numbers, never who).
  stats(id) {
    const all = this.store.readersOf(id, { all: true }).filter((r) => this.who(r.reader));
    const rs = all.filter((r) => r.entry.status !== "abandoned");
    const rated = rs.filter((r) => r.entry.rating != null);
    const avg = rated.length ? Math.round((rated.reduce((s, r) => s + r.entry.rating, 0) / rated.length) * 10) / 10 : null;
    const dropped = all.length - rs.length;
    return { avg, rated: rated.length, want: rs.filter((r) => r.entry.status === "want").length, readers: rs.length, finished: rs.filter((r) => r.entry.status === "read").length, dropped };
  }

  // The feed: the newest changes first (entries carry `updated` since 2026-10-20), then the imported
  // ones by year and the reader's own order. `books` limits it to a set of works, `notes` to entries with
  // a note, `min` to ratings from that up, `readers` to a set of reader ids (whom one follows).
  feed({ limit = 6, books = null, notes = false, min = 0, readers = null, perReader = 0 } = {}) {
    const items = this.all().filter(({ reader, id, entry: e }) => (!readers || readers.has(reader.id)) && (!books || books.has(id)) && (!notes || e.note) && (!min || (e.rating ?? 0) >= min));
    const at = (e) => e.updated || e.added || "";
    items.sort((a, b) => (at(b.entry) > at(a.entry) ? 1 : at(b.entry) < at(a.entry) ? -1 : 0) || (b.entry.year ?? 0) - (a.entry.year ?? 0) || (a.entry.order ?? 0) - (b.entry.order ?? 0));
    const out = [];
    const per = new Map(); // reader id -> rows taken, for `perReader`
    for (const it of items) {
      if (perReader && (per.get(it.reader.id) || 0) >= perReader) continue;
      const book = this.store.book(it.id);
      if (!book) continue;
      out.push({ ...it, book });
      per.set(it.reader.id, (per.get(it.reader.id) || 0) + 1);
      if (out.length >= limit) break;
    }
    return out;
  }

  // «Книжка навмання»: books someone rated 4,5 or more and wrote about, a different order every time.
  picks(limit = 12) {
    const seen = new Set();
    const out = [];
    for (const it of shuffle(this.all().filter(({ entry: e }) => e.rating >= 4.5 && e.note))) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const book = this.store.book(it.id);
      if (book) out.push({ ...it, book });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Books readers rated 4 or more, with their mean rating: id -> { book, avg }.
  liked() {
    const m = new Map();
    for (const { id, entry: e } of this.all()) {
      if (e.rating == null) continue;
      const x = m.get(id) || m.set(id, { sum: 0, n: 0 }).get(id);
      x.sum += e.rating;
      x.n++;
    }
    const out = new Map();
    for (const [id, x] of m) {
      const avg = Math.round((x.sum / x.n) * 10) / 10;
      if (avg < 4) continue;
      const book = this.store.book(id);
      if (book) out.set(id, { book, avg });
    }
    return out;
  }

  // «Популярне» (/popular): what readers do most, by work (a translation counts for its pair, shown as the
  // Ukrainian one). Kept for ten minutes: it looks at every entry of every reader.
  // `reading` — readers with it «Читаю» now; `want` — «Хочу прочитати»; `top` — the best mean rating
  // with a few ratings at least; `month` — readers who added, rated or changed it in the last 30 days.
  popular({ limit = 12 } = {}) {
    if (this.pop && Date.now() - this.pop.at < 10 * 60 * 1000) return this.pop.out;
    const s = this.store;
    const key = (id) => {
      const c = s.canonical(id);
      const tr = s.translations?.get(c);
      return tr?.size ? [c, ...tr].sort()[0] : c;
    };
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const works = new Map(); // key -> { ids, reading, want, sum, rated, month }
    for (const { reader, id, entry: e } of this.all()) {
      const k = key(id);
      const w = works.get(k) || works.set(k, { ids: new Map(), reading: new Set(), want: new Set(), sum: 0, rated: 0, month: new Set(), all: new Set() }).get(k);
      w.ids.set(id, (w.ids.get(id) || 0) + 1);
      w.all.add(reader.id);
      if (e.status === "reading") w.reading.add(reader.id);
      if (e.status === "want") w.want.add(reader.id);
      if (e.rating != null) (w.sum += e.rating), w.rated++;
      if ((e.updated || e.added || "") >= cutoff) w.month.add(reader.id);
    }
    // The member to show: one with a Ukrainian title first, then the one most readers have.
    const shown = (w) => {
      const bs = [...w.ids].sort((a, b) => b[1] - a[1]).map(([id]) => s.book(id)).filter(Boolean);
      return bs.find((b) => /[а-яіїєґ]/i.test(b.title)) || bs[0] || null;
    };
    const rows = [...works.values()];
    const taken = new Set();
    const take = (list, score, min, extra, { fresh = false } = {}) => {
      const out = [];
      for (const w of list.filter((w) => score(w) >= min).sort((a, b) => score(b) - score(a) || b.all.size - a.all.size)) {
        const book = shown(w);
        if (!book || isRussian(book) || (fresh && taken.has(book.id))) continue;
        taken.add(book.id);
        out.push({ book, avg: w.rated ? Math.round((w.sum / w.rated) * 10) / 10 : null, rated: w.rated, n: extra(w) });
        if (out.length >= limit) break;
      }
      return out;
    };
    // A mean of few ratings is pulled toward 4 (the site's usual), so one reader's five doesn't top it.
    const top = (w) => (w.rated >= 2 ? (w.sum + 4 * 3) / (w.rated + 3) : 0);
    const out = {
      reading: take(rows, (w) => w.reading.size, 1, (w) => w.reading.size),
      want: take(rows, (w) => w.want.size, 2, (w) => w.want.size),
      // Books already up there are left out, so the month shows what else is moving.
      month: take(rows, (w) => w.month.size, 2, (w) => w.month.size, { fresh: true }),
      top: take(rows, top, 0.01, (w) => w.rated),
    };
    this.pop = { at: Date.now(), out };
    return out;
  }

  // «Якщо сподобалась X»: well rated books sharing most of X's tags, X itself and `skip` left out.
  similar(ids, { limit = 6, skip = new Set() } = {}) {
    const want = new Map();
    for (const id of ids) for (const t of tagsOf(this.store.book(id))) want.set(t, (want.get(t) || 0) + 1);
    if (!want.size) return [];
    const out = [];
    for (const [id, x] of this.liked()) {
      if (ids.includes(id) || skip.has(id)) continue;
      const shared = tagsOf(x.book).reduce((s, t) => s + (want.get(t) || 0), 0);
      if (shared) out.push({ ...x, score: shared * 10 + x.avg + Math.random() });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Three books to start recommendations from: the reader's own latest fives, or for a guest (or a
  // reader without fives) three random well rated books with tags.
  seeds(readerId) {
    const own = readerId ? this.store.library(readerId).filter((r) => r.rating >= 5 && tagsOf(r.book).length) : [];
    if (own.length) return own.slice(0, 3).map((r) => r.book);
    return shuffle([...this.liked().values()].filter((x) => x.avg >= 4.5 && tagsOf(x.book).length && x.book.cover)).slice(0, 3).map((x) => x.book);
  }

  // «Читали це, сподобалось і це»: what the readers who liked these books rated 4,5 or more, most
  // shared first; topped up with similar books.
  alsoLiked(ids, { limit = 4, skip = new Set() } = {}) {
    const fans = new Set(this.all().filter(({ id, entry: e }) => ids.includes(id) && (e.rating ?? 0) >= 4).map((x) => x.reader.id));
    // Each fan who loved a book counts; so does every tag it shares with these books (with few readers
    // yet, a lone reader's fives would otherwise come up at random).
    const tags = new Set(ids.flatMap((id) => tagsOf(this.store.book(id))));
    const m = new Map();
    for (const { reader, id, entry: e } of this.all()) {
      if (!fans.has(reader.id) || ids.includes(id) || skip.has(id) || (e.rating ?? 0) < 4.5) continue;
      const shared = m.has(id) ? 0 : tagsOf(this.store.book(id)).filter((t) => tags.has(t)).length * 2;
      m.set(id, (m.get(id) || Math.random()) + 1 + shared);
    }
    const out = [...m].sort((a, b) => b[1] - a[1]).map(([id]) => this.store.book(id)).filter(Boolean).slice(0, limit);
    if (out.length < limit) {
      const have = new Set([...out.map((b) => b.id), ...skip]);
      out.push(...this.similar(ids, { limit: limit - out.length, skip: have }).map((x) => x.book));
    }
    return out;
  }

  // The same, and when that leaves room (a book nobody rated yet, with no genres: Max 2026-10-23, Піпс),
  // the author's other books, readers' favourites first.
  alsoForBook(id, { limit = 4 } = {}) {
    const out = this.alsoLiked([id], { limit });
    if (out.length >= limit) return out;
    const book = this.store.book(id);
    const have = new Set([id, ...out.map((b) => b.id)]);
    const liked = this.liked();
    const { splitAuthors } = require("./authors");
    const ids = [...new Set(splitAuthors(book?.author).flatMap((n) => this.store.authors?.byName(n)?.ids || []))].map((i) => this.store.canonical(i));
    const more = [...new Set(ids)]
      .filter((i) => !have.has(i))
      .map((i) => ({ book: this.store.book(i), avg: liked.get(i)?.avg ?? 0 }))
      .filter((x) => x.book)
      .sort((a, b) => b.avg - a.avg || !!b.book.cover - !!a.book.cover);
    return [...out, ...more.slice(0, limit - out.length).map((x) => x.book)];
  }
}

module.exports = { Social, tagsOf };
