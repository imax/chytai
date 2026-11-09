// Offline check of recommenders on a copy of the DB (scripts/fetch-test-db.sh): for each reader with 6+ books
// rated 4+, hide a fifth of those, ask each method for 10 books from the rest, count how many hidden ones come back.
// node web/scripts/recs-eval.js [dataDir]
const path = require("path");
const { Store, isRussian } = require("../store");
const { Social } = require("../social");
const { Recs } = require("../recs");
const dir = process.argv[2] || path.join(__dirname, "../../data/web");
const store = new Store(dir);
const social = new Social(store, (id) => ({ id, name: id, href: "/@" + id }));
const recs = new Recs(store, { skipBook: isRussian });
let t = Date.now();
const full = recs.build();
console.log(`build: ${full.ms} ms, readers ${full.users}, books with neighbours ${full.near.size}`);
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const R = rnd(42);
const N = 10;
const res = {}; const per = {};
let cases = 0;
const orig = new Map(store.entries);
for (const [rid, entries] of orig) {
  const pos = Object.entries(entries).filter(([, e]) => e.rating >= 4 && !e.kids);
  if (pos.length < 6) continue;
  const held = pos.map((x) => [x, R()]).sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, Math.round(pos.length / 5))).map(([[id]]) => id);
  const heldW = new Set(held.map((id) => recs.work(id)));
  const rest = { ...entries };
  for (const id of held) delete rest[id];
  store.entries.set(rid, rest);
  store.entriesV++;
  store.readerV.set(rid, (store.readerV.get(rid) || 0) + 1);
  recs.model = null; social.pop = null;
  const own = new Map(Object.entries(rest));
  const shelf = Object.entries(rest).filter(([, e]) => e.rating != null && !e.kids);
  const liked = shelf.filter(([, e]) => e.rating >= 4);
  const seeds = (liked.length ? liked : shelf).sort((a, b) => b[1].rating - a[1].rating).slice(0, 5).map(([id]) => id);
  const lists = {
    cf: recs.forReader(rid, { limit: N }).map((x) => x.id),
    tags: social.similar(seeds, { limit: N, skip: own, own }).map((x) => x.book.id),
    also: social.alsoLiked(seeds, { limit: N, skip: own }).map((b) => b.id),
    pop: social.popular({ limit: 40 }).top.map((x) => x.book.id).filter((id) => !own.has(id)).slice(0, N),
  };
  const m = recs.get();
  const maxR = Math.max(...m.readers.values());
  const popS = (w) => Math.log(1 + (m.readers.get(w) || 0)) / Math.log(1 + maxR);
  for (const a of [0.1, 0.3, 1]) {
    const raw = recs.forReader(rid, { limit: 200 });
    const top = raw.length ? raw[0].score : 1;
    const sc = new Map(raw.map((x) => [x.id, x.score / top]));
    for (const id of lists.pop) sc.set(recs.work(id), (sc.get(recs.work(id)) || 0));
    for (const w of m.readers.keys()) if (!sc.has(w) && m.readers.get(w) >= 3 && !own.has(w)) sc.set(w, 0);
    lists['hyb' + a] = [...sc].filter(([w]) => !own.has(w) && !Object.keys(rest).some((id) => recs.work(id) === w)).map(([w, v]) => [w, v + a * popS(w)]).sort((x, y) => y[1] - x[1]).slice(0, N).map(([w]) => w);
  }
  const cf = lists.cf;
  lists.mix = [...cf, ...lists.tags.filter((id) => !cf.includes(id)), ...lists.pop].slice(0, N);
  for (const [k, l] of Object.entries(lists)) {
    const hits = new Set(l.map((id) => recs.work(id)).filter((w) => heldW.has(w))).size;
    res[k] ||= [0, 0, 0]; per[k] = (per[k] || 0) + hits / heldW.size;
    res[k][0] += hits;
    res[k][1] += heldW.size;
    res[k][2] += hits ? 1 : 0;
  }
  cases++;
  store.entries.set(rid, entries);
}
console.log(`readers tested: ${cases}`);
for (const [k, [h, n, any]] of Object.entries(res)) console.log(`${k.padEnd(5)} recall@${N} ${((100 * h) / n).toFixed(1)}%  readers with a hit ${((100 * any) / cases).toFixed(0)}%  (${h}/${n})  mean per reader ${(100 * per[k] / cases).toFixed(1)}%`);
console.log(`total ${Date.now() - t} ms`);
