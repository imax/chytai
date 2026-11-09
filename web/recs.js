// Recommendations without an LLM (Max, 2026-11-09): item-item collaborative filtering on what readers
// did with books here. Two books are close when the same readers liked both; a reader gets the books
// closest to the ones they liked. Free at request time: the model is a table of neighbours per book,
// built in memory from the entries every ten minutes (or when the entries change and the old one is stale).
//
// Signals per reader and work (a translation counts for its pair, like social.popular()):
//   rating 4.5–5 → 1, rating 4 → 0.8, read or reading without a rating → 0.5, want → 0.3,
//   rating 3 or less, abandoned, kids' shelf → nothing (not a sign they want more like it).
// Only a reader's 300 latest books count for pairs (a Goodreads import of 700 would be 490k pairs alone).
// Similarity is cosine, shrunk toward 0 when few readers share the pair: × co / (co + SHRINK).
// Tuned on the test DB of 2026-11-09 with scripts/recs-eval.js (damping big shelves made it worse).
// Books with too few readers have no neighbours; the caller tops up with social.similar() (tags) and
// popular books, so a newcomer or a rare book still gets a full list.
//
// Built to be swapped or improved (e.g. by Sergei): everything goes through `forReader` and `forBooks`.

const MAX_PER_READER = 300; // latest books of a reader that count for pairs (keeps the build ~O(readers × 300²))
const NEIGHBOURS = 100; // kept per book
const SHRINK = 10; // a pair shared by 1 reader counts 1/11, by 10 half: few shared readers are mostly chance
const MIN_READERS = 2; // a book needs this many readers to have neighbours
const TTL = 10 * 60 * 1000;

function signal(e) {
  if (e.kids || e.status === "abandoned") return 0;
  if (e.rating != null) return e.rating >= 4.5 ? 1 : e.rating >= 4 ? 0.8 : 0;
  if (e.status === "read" || e.status === "reading") return 0.5;
  if (e.status === "want") return 0.3;
  return 0;
}

class Recs {
  // `ok(readerId)` says whose entries count (public readers); `skipBook(book)` drops books (Russian etc.).
  constructor(store, { ok = () => true, skipBook = () => false } = {}) {
    this.store = store;
    this.ok = ok;
    this.skipBook = skipBook;
    this.model = null;
  }

  // The work a book belongs to: the canonical id, or for a translation pair the smaller id of the pair.
  work(id) {
    const s = this.store;
    const c = s.canonical(id);
    const tr = s.translations?.get(c);
    return tr?.size ? [c, ...tr].sort()[0] : c;
  }

  get() {
    const m = this.model;
    if (m && (m.v === this.store.entriesV || Date.now() - m.at < TTL)) return m;
    return (this.model = this.build());
  }

  build(exclude = null) {
    const t0 = Date.now();
    const s = this.store;
    const users = []; // [[work, weight]] per reader, latest first
    const readers = new Map(); // work -> readers with a signal
    for (const [rid, entries] of s.entries) {
      if (!this.ok(rid)) continue;
      const list = [];
      const seen = new Set();
      const rows = Object.entries(entries).sort((a, b) => ((b[1].updated || b[1].added || "") > (a[1].updated || a[1].added || "") ? 1 : -1));
      for (const [id, e] of rows) {
        if (exclude?.(rid, id)) continue;
        const w = signal(e);
        if (!w) continue;
        const k = this.work(id);
        if (seen.has(k)) continue;
        const book = s.book(k);
        if (!book || this.skipBook(book)) continue;
        seen.add(k);
        list.push([k, w]);
      }
      if (!list.length) continue;
      users.push(list);
      for (const [k] of list) readers.set(k, (readers.get(k) || 0) + 1);
    }
    // Norms and co-occurrence over the books with enough readers.
    const norm = new Map();
    const dot = new Map(); // work -> Map(work -> [sum, co])
    for (const u of users) {
      const items = u.filter(([k]) => readers.get(k) >= MIN_READERS).slice(0, MAX_PER_READER);
      for (const [k, w] of items) norm.set(k, (norm.get(k) || 0) + w * w);
      for (let i = 0; i < items.length; i++) {
        const [a, wa] = items[i];
        const row = dot.get(a) || dot.set(a, new Map()).get(a);
        for (let j = 0; j < items.length; j++) {
          if (i === j) continue;
          const [b, wb] = items[j];
          const x = row.get(b);
          if (x) (x[0] += wa * wb), x[1]++;
          else row.set(b, [wa * wb, 1]);
        }
      }
    }
    const near = new Map(); // work -> [[work, sim]] best first
    for (const [a, row] of dot) {
      const na = Math.sqrt(norm.get(a));
      const list = [];
      for (const [b, [sum, co]] of row) list.push([b, (sum / (na * Math.sqrt(norm.get(b)))) * (co / (co + SHRINK))]);
      list.sort((x, y) => y[1] - x[1]);
      near.set(a, list.slice(0, NEIGHBOURS));
    }
    return { at: Date.now(), v: s.entriesV, near, readers, users: users.length, ms: Date.now() - t0 };
  }

  // Books close to these (ids, or [id, weight]): [{ id, score, because }] best first, the seeds and `skip` left out.
  forBooks(seeds, { limit = 6, skip = new Set(), model = null } = {}) {
    const m = model || this.get();
    const from = seeds.map((x) => (Array.isArray(x) ? [this.work(x[0]), x[1]] : [this.work(x), 1]));
    const own = new Set(from.map(([k]) => k));
    const skipW = new Set([...skip].map((id) => this.work(id)));
    const score = new Map();
    for (const [k, w] of from)
      for (const [b, sim] of m.near.get(k) || []) {
        if (own.has(b) || skipW.has(b)) continue;
        const x = score.get(b) || score.set(b, { id: b, score: 0, because: k, best: 0 }).get(b);
        x.score += sim * w;
        if (sim * w > x.best) (x.best = sim * w), (x.because = k);
      }
    return [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // For a reader: seeds are their own books with a signal, newest first (up to 50).
  forReader(readerId, { limit = 6, skip = new Set(), model = null, exclude = null } = {}) {
    const entries = this.store.entriesOf(readerId) || {};
    const seeds = Object.entries(entries)
      .filter(([id]) => !exclude?.(readerId, id))
      .map(([id, e]) => [id, signal(e), e.updated || e.added || ""])
      .filter((x) => x[1] > 0)
      .sort((a, b) => (b[2] > a[2] ? 1 : -1))
      .slice(0, 50)
      .map(([id, w]) => [id, w]);
    const have = new Set([...Object.keys(entries), ...skip]);
    return this.forBooks(seeds, { limit, skip: have, model });
  }
}

module.exports = { Recs, signal };
