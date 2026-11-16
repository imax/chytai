// Put a release on the volume and ask main.js to switch to it (release.js says how and why). web.yml runs it on the
// machine after uploading the site's files:
//   flyctl ssh sftp put site.tgz /data/web/releases/incoming/<sha>.tgz
//   flyctl ssh console -C "node /app/web/hotdeploy.js <sha>"
// The last line it prints is «HOT: ok …», «HOT: full …» (needs an image deploy; nothing changed on the site) or
// «HOT: failed …» (the new code did not open its pages; the old code goes on answering). Exit codes 0 / 3 / 4.
// `node web/hotdeploy.js <sha of a release already there>` switches back to it (a rollback), the image's own sha too.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

if (!process.env.DATA_DIR && fs.existsSync("/data")) process.env.DATA_DIR = "/data"; // an ssh session may lack the machine's env
const out = (kind, text, code) => {
  console.log(`HOT: ${kind} ${text}`);
  process.exit(code);
};

const sha = String(process.argv[2] || "").trim();
const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "web", "releases");
const main = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "main.json"), "utf8"));
  } catch {
    return null;
  }
})();
if (!main?.pid) out("full", "main.js does not know releases yet (an older image)", 3);
process.env.GIT_SHA = main.image || process.env.GIT_SHA || "";
const release = require("./release");
if (!release.SHA.test(sha)) out("failed", "usage: hotdeploy.js <commit sha>", 4);
try {
  process.kill(main.pid, 0);
} catch {
  out("full", `main.js (pid ${main.pid}) is not running`, 3);
}

// Unpack an uploaded release next to the others, then move it in whole.
const tgz = path.join(release.INCOMING, `${sha}.tgz`);
const dir = path.join(release.DIR, sha);
if (fs.existsSync(tgz) && !fs.existsSync(dir)) {
  const tmp = `${dir}.tmp`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "inherit" });
    fs.symlinkSync(path.join(release.IMAGE, "node_modules"), path.join(tmp, "node_modules"));
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    out("full", `could not unpack: ${e.message}`, 3);
  }
}
fs.rmSync(tgz, { force: true });
const r = release.ready(sha);
if (!r.dir) out(r.full ? "full" : "failed", r.why, r.full ? 3 : 4);

// Ask main.js and wait for its answer (a fresh web process needs ~10–30 s to read the catalog).
const at = new Date().toISOString();
const result = path.join(release.DIR, `result-${sha}.json`);
fs.rmSync(result, { force: true });
release.writeJson(path.join(release.DIR, "request.json"), { sha, at });
process.kill(main.pid, "SIGHUP");
const t0 = Date.now();
const wait = () => {
  const r = release.readJson(result);
  if (r) {
    if (r.ok) out("ok", `${sha.slice(0, 7)} answers after ${Math.round(r.ms / 1000)} s (before: ${String(r.prev || "").slice(0, 7)})`, 0);
    out(r.full ? "full" : "failed", r.why || "no reason", r.full ? 3 : 4);
  }
  if (Date.now() - t0 > 240000) out("failed", "main.js did not answer in 4 minutes", 4);
  setTimeout(wait, 500);
};
wait();
