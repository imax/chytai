// A list's picture for social networks (Max, 2026-10-27: «не забудь про превʼю для соц мереж»): when the
// author has not put a picture of their own, one 1200×630 JPEG of its first covers fanned out on the site's
// green, the same look as the top of the list's page. Made once per set of covers (the file name is a hash of
// them) with libvips: the covers' small copies (thumbs.js) go into an SVG, and vips draws it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const W = 1200;
const H = 630;
const run = (cmd, args) => new Promise((ok, fail) => execFile("nice", ["-n", "10", cmd, ...args], { timeout: 30000 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim().split("\n")[0])) : ok())));

class ListImage {
  constructor({ dir, thumbs, log = console.log }) {
    this.dir = path.join(dir, "og");
    this.thumbs = thumbs;
    this.log = log;
    this.made = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // The file's name for these covers: the same covers, the same picture.
  name(covers) {
    return `${crypto.createHash("sha1").update(covers.join("\n")).digest("hex").slice(0, 20)}.jpg`;
  }

  // The picture's file for these cover addresses (up to five are used), made now if need be; null without covers.
  async file(covers) {
    covers = covers.filter(Boolean).slice(0, 5);
    if (!covers.length) return null;
    const out = path.join(this.dir, this.name(covers));
    if (fs.existsSync(out)) return out;
    if (!this.made.has(out)) this.made.set(out, this.make(covers, out).catch((e) => (this.log(`listimage: ${e.message}`), null)).finally(() => this.made.delete(out)));
    return this.made.get(out);
  }

  async make(covers, out) {
    const tmp = [];
    try {
      // librsvg reads JPEG and PNG in an SVG, not WebP: each small copy becomes a JPEG first.
      const jpgs = [];
      for (const src of covers) {
        const webp = await this.thumbs.file(src);
        if (!webp) continue;
        const jpg = `${out}.${process.pid}.${jpgs.length}.jpg`;
        tmp.push(jpg);
        await run("vips", ["copy", webp, `${jpg}[Q=90]`]);
        jpgs.push(fs.readFileSync(jpg).toString("base64"));
      }
      if (!jpgs.length) return null;
      // The middle cover in front and highest, the others turned out to the sides (pages.js listHero).
      const n = jpgs.length;
      const order = [...Array(n).keys()].sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2));
      const cw = 270;
      const ch = 405;
      const step = 195;
      const books = order
        .map((i) => {
          const off = i - (n - 1) / 2;
          const x = W / 2 + off * step - cw / 2;
          const y = (H - ch) / 2 + 40 + Math.abs(off) * 30;
          return `<g transform="rotate(${off * 5} ${x + cw / 2} ${y + ch})"><rect x="${x - 5}" y="${y - 5}" width="${cw + 10}" height="${ch + 10}" rx="5" fill="#f7f4ee" filter="url(#s)"/><image x="${x}" y="${y}" width="${cw}" height="${ch}" preserveAspectRatio="xMidYMid slice" href="data:image/jpeg;base64,${jpgs[i]}"/></g>`;
        })
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="g" cx="15%" cy="10%" r="130%"><stop offset="0" stop-color="#2f5d48"/><stop offset=".55" stop-color="#1d3a2e"/><stop offset="1" stop-color="#14271f"/></radialGradient>
<pattern id="d" width="38" height="38" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.4" fill="#fff" fill-opacity=".35"/><circle cx="21" cy="21" r="1.1" fill="#fff" fill-opacity=".22"/></pattern>
<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".5"/></filter></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#d)"/>${books}</svg>`;
      const svgFile = `${out}.${process.pid}.svg`;
      tmp.push(svgFile);
      fs.writeFileSync(svgFile, svg);
      const part = `${out}.${process.pid}.part.jpg`;
      tmp.push(part);
      await run("vips", ["copy", svgFile, `${part}[Q=82,strip]`]);
      fs.renameSync(part, out);
      return out;
    } finally {
      for (const f of tmp) fs.rmSync(f, { force: true });
    }
  }
}

module.exports = { ListImage };
