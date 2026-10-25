// Small copies of covers (Max, 2026-10-25: «обкладинок багато»). A shelf shows a cover the size of a matchbox,
// but the picture behind it is the shop's or Open Library's full one, 60–100 KB. Here a cover at a small size
// is made once (vipsthumbnail, libvips; the Dockerfile installs it), kept as WebP under DATA_DIR/covers/t and
// then served for a year from our own server.
//
// The address is /t/<width>/<signature>/<picture address in base64url>: the signature (HMAC with a key kept in
// meta) means only addresses the pages wrote are fetched, so this is no open proxy. A picture that can't be
// fetched or made small sends the browser to the original (the page's own retry and coloured block take over).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const WIDTHS = [128, 240]; // twice the width shown: md/sm/xs/feed are ≤64 px, lg and the grid's cards ≤120
const BUDGET = 250 * 1024 * 1024; // the copies together; the oldest go beyond it (made again when asked)
const PARALLEL = 3; // pictures made at once; the rest wait their turn
const QUEUE = 40; // beyond this many waiting the browser goes to the original at once

class Thumbs {
  constructor({ db, dir, log = console.log }) {
    this.dir = path.join(dir, "t");
    this.log = log;
    let key = db.get("thumbs:key");
    if (!key) db.set("thumbs:key", (key = crypto.randomBytes(24).toString("hex")));
    this.key = key;
    this.covers = dir; // our own /covers/<name> pictures are read from here
    this.running = 0;
    this.waiting = [];
    this.failed = new Map(); // address -> time it failed; tried again after an hour
    this.made = new Map(); // file -> promise, so two browsers asking at once make it once
    for (const w of WIDTHS) fs.mkdirSync(path.join(this.dir, String(w)), { recursive: true });
  }

  sign(w, url) {
    return crypto.createHmac("sha256", this.key).update(`${w} ${url}`).digest("hex").slice(0, 16);
  }

  // The small copy's address for a cover shown `shown` px wide, or the cover itself when there is none to make.
  url(src, shown) {
    if (!src || !(/^https?:\/\//.test(src) || /^\/covers\/[\w.-]+$/.test(src))) return src;
    const w = WIDTHS.find((x) => x >= shown * 2) || WIDTHS[WIDTHS.length - 1];
    return `/t/${w}/${this.sign(w, src)}/${Buffer.from(src).toString("base64url")}`;
  }

  // GET /t/:w/:sig/:src
  async serve(req, res) {
    const w = Number(req.params.w);
    let src = "";
    try {
      src = Buffer.from(req.params.src, "base64url").toString();
    } catch {}
    if (!WIDTHS.includes(w) || !src || req.params.sig !== this.sign(w, src)) return res.status(404).end();
    const file = path.join(this.dir, String(w), `${crypto.createHash("sha1").update(src).digest("hex")}.webp`);
    const send = () => res.set("Cache-Control", "public, max-age=31536000, immutable").type("image/webp").sendFile(file);
    if (fs.existsSync(file)) return send();
    const away = () => res.set("Cache-Control", "public, max-age=3600").redirect(302, src);
    if (Date.now() - (this.failed.get(src) || 0) < 3600 * 1000) return away();
    if (this.waiting.length >= QUEUE && !this.made.has(file)) return away();
    const ok = await (this.made.get(file) || this.make(src, w, file));
    if (ok) send();
    else away();
  }

  make(src, w, file) {
    const p = this.turn(() => this.build(src, w, file))
      .catch((e) => (this.log(`thumbs: ${src.slice(0, 100)}: ${e.message}`), this.failed.set(src, Date.now()), false))
      .finally(() => this.made.delete(file));
    this.made.set(file, p);
    return p;
  }

  async turn(job) {
    if (this.running >= PARALLEL) await new Promise((go) => this.waiting.push(go));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  async build(src, w, file) {
    let input;
    let tmp = "";
    if (src.startsWith("/covers/")) input = path.join(this.covers, path.basename(src));
    else {
      const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: new URL(src).origin + "/" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200 || buf.length > 15e6) throw new Error(`розмір ${buf.length} байт`);
      input = tmp = `${file}.${process.pid}.src`;
      fs.writeFileSync(tmp, buf);
    }
    const out = `${file}.${process.pid}.tmp.webp`;
    try {
      // --size Wx>: that width, the height kept in proportion, never larger than the original; at a lower
      // priority than the pages (it runs beside the site, on the same processor).
      await new Promise((ok, fail) => execFile("nice", ["-n", "10", "vipsthumbnail", input, "--size", `${w}x>`, "-o", `${out}[Q=72,strip]`], { timeout: 20000 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim().split("\n")[0])) : ok())));
      fs.renameSync(out, file);
      return true;
    } finally {
      for (const f of [tmp, out]) if (f) fs.rmSync(f, { force: true });
    }
  }

  // Makes the small copies of these covers ahead of the first reader who would wait for them (the jobs
  // process: every cover on a reader's shelf), one at a time.
  async warm(srcs, w = WIDTHS[0]) {
    let made = 0;
    for (const src of new Set(srcs)) {
      if (!src || this.url(src, 1) === src) continue;
      const file = path.join(this.dir, String(w), `${crypto.createHash("sha1").update(src).digest("hex")}.webp`);
      if (fs.existsSync(file) || Date.now() - (this.failed.get(src) || 0) < 3600 * 1000) continue;
      if (await this.make(src, w, file)) made++;
      await new Promise((ok) => setTimeout(ok, 300));
    }
    if (made) this.log(`thumbs: ${made} small copies made ahead`);
    return made;
  }

  // The copies over BUDGET, oldest first, go (the jobs process, once a day).
  prune() {
    const all = [];
    for (const w of WIDTHS) {
      const d = path.join(this.dir, String(w));
      for (const name of fs.readdirSync(d)) {
        const st = fs.statSync(path.join(d, name), { throwIfNoEntry: false });
        if (st) all.push({ f: path.join(d, name), size: st.size, at: st.mtimeMs });
      }
    }
    let total = all.reduce((n, x) => n + x.size, 0);
    const before = total;
    let gone = 0;
    for (const x of all.sort((a, b) => a.at - b.at)) {
      if (total <= BUDGET) break;
      fs.rmSync(x.f, { force: true });
      total -= x.size;
      gone++;
    }
    this.log(`thumbs: ${all.length} copies, ${Math.round(before / 1048576)} MB${gone ? `; ${gone} oldest removed, ${Math.round(total / 1048576)} MB left` : ""}`);
    return gone > 0;
  }
}

module.exports = { Thumbs, WIDTHS };
