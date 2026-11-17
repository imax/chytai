// Code updates without restarting the machine (Max, 2026-11-16: «20, 30, 40 релізів на день це прикольно», but
// the site must not go down for them). The image keeps node_modules, the system packages and main.js; the site's own
// code can come as a release on the volume instead: DATA_DIR/web/releases/<sha>/ (web/, server/agent.js,
// server/aimeter.js, build/icon.png; web/node_modules a link to the image's). web.yml uploads it
// (`flyctl ssh sftp put`), hotdeploy.js unpacks it and asks main.js to switch: a fresh web process starts on the
// new code while the old one answers, opens a few pages on a private port, and only then takes the site's port.
//
// Safety (Max: «щоб наш фікс не створив більше проблем, ніж він вирішує»):
// - a release may differ from the image only in the site's code: web/package*.json, main.js, this file, hotdeploy.js,
//   the Dockerfile and fly.toml must be the image's, byte for byte, or it is refused and web.yml deploys an image;
// - current.json remembers which image a release was put on: a new image (a full deploy) starts on its own code;
//   a restart of the same machine starts on the release, so it does not quietly go back to older code;
// - a release whose web process dies before it answers at boot is dropped and the image's code starts instead.
// Kept: the 8 newest releases and the one running. Switch it off: repo variable HOT_DEPLOY=off (web.yml).
const fs = require("fs");
const path = require("path");

const IMAGE = path.join(__dirname, ".."); // the code baked into the image
const DIR = path.join(process.env.DATA_DIR || path.join(IMAGE, "data"), "web", "releases");
const INCOMING = path.join(DIR, "incoming");
const IMAGE_SHA = process.env.GIT_SHA || "";
const MUST_MATCH = ["web/package.json", "web/package-lock.json", "web/main.js", "web/release.js", "web/hotdeploy.js", "web/Dockerfile", "web/fly.toml"];
const KEEP = 8;
const SHA = /^[0-9a-f]{7,40}$/;

const read = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v));
  fs.renameSync(`${f}.tmp`, f);
};

// The files of MUST_MATCH a release has different from the image (a missing one differs too).
function differs(dir) {
  return MUST_MATCH.filter((f) => {
    const a = read(path.join(IMAGE, f));
    const b = read(path.join(dir, f));
    return !a || !b || !a.equals(b);
  });
}

// { sha, dir } of a release ready to run, or { why } (`full: true`: it needs an image deploy).
function ready(sha) {
  if (!SHA.test(String(sha || ""))) return { why: "no such commit" };
  if (IMAGE_SHA && IMAGE_SHA.startsWith(sha)) return { sha: IMAGE_SHA, dir: IMAGE };
  const dir = path.join(DIR, sha);
  if (!fs.existsSync(path.join(dir, "web", "server.js"))) return { why: `release ${sha} is not on the volume`, full: true };
  const d = differs(dir);
  if (d.length) return { why: `needs an image: ${d.join(", ")} changed`, full: true };
  return { sha, dir };
}

// What main.js starts on: the release put on this very image, else the image's code.
function current() {
  const c = readJson(path.join(DIR, "current.json"));
  if (!c?.sha || c.image !== IMAGE_SHA) return { sha: IMAGE_SHA, dir: IMAGE, image: true };
  const r = ready(c.sha);
  return r.dir ? { ...r, image: r.dir === IMAGE } : { sha: IMAGE_SHA, dir: IMAGE, image: true, why: r.why };
}

function setCurrent(sha, prev) {
  fs.mkdirSync(DIR, { recursive: true });
  writeJson(path.join(DIR, "current.json"), { sha, prev, image: IMAGE_SHA, at: new Date().toISOString() });
  prune(sha, prev);
}

// The release did not start: back to the image's code at the next start, and the reason kept for /agent/health.
function drop(sha, why) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(path.join(DIR, "current.json"), { force: true });
    writeJson(path.join(DIR, "dropped.json"), { sha, why, at: new Date().toISOString() });
  } catch {}
}

function prune(...keep) {
  try {
    const dirs = fs
      .readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SHA.test(e.name))
      .map((e) => ({ name: e.name, t: fs.statSync(path.join(DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP)) if (!keep.includes(d.name)) fs.rmSync(path.join(DIR, d.name), { recursive: true, force: true });
    for (const f of fs.readdirSync(INCOMING)) if (Date.now() - fs.statSync(path.join(INCOMING, f)).mtimeMs > 86400000) fs.rmSync(path.join(INCOMING, f), { force: true });
    for (const f of fs.readdirSync(DIR)) if (/^result-/.test(f) && Date.now() - fs.statSync(path.join(DIR, f)).mtimeMs > 86400000) fs.rmSync(path.join(DIR, f), { force: true });
  } catch {}
}

// For /agent/health: what runs and from where.
function state() {
  return { current: readJson(path.join(DIR, "current.json")), dropped: readJson(path.join(DIR, "dropped.json")) };
}

module.exports = { IMAGE, DIR, INCOMING, IMAGE_SHA, MUST_MATCH, SHA, ready, current, setCurrent, drop, prune, state, readJson, writeJson };
