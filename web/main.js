// The site and its background jobs as two processes (Max, 2026-10-24, after 14 minutes of a site that stood
// still while something in the background used the processor: «давай винесемо bg tasks в окрему чергу»).
//
// This process only starts the other two and passes messages between them; it holds no data.
// - web: server.js with CHYTAI_ROLE=web answers the pages and starts no background work;
// - jobs: server.js with CHYTAI_ROLE=jobs listens on no port and runs the catalog refresh, the Haiku passes,
//   Wikidata, the free-books check, the automatic overviews and the weekly letter (jobs.js says which).
// The web side asks the jobs side to start something ({ type: "call" }), sees what is running ({ type:
// "status" }), and when a job has changed what the pages show ({ type: "changed" }) a fresh web process is
// started: it reads everything from the database while the old one goes on answering, then takes over. Either
// process that dies is started again. `node web/server.js` alone still runs everything in one process.
const cluster = require("cluster");
const path = require("path");
const fs = require("fs");

// The deploy log (deploys.js, Max 2026-11-16): the moment Fly stopped us is kept in this file across the restart,
// and the next start tells the web process how long the site was gone (from the stop to the first page answered).
const STARTED = Date.now();
const STOP_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "web", "main-stop.json");
let lastStop = null;
try {
  lastStop = JSON.parse(fs.readFileSync(STOP_FILE, "utf8"));
  fs.unlinkSync(STOP_FILE);
} catch {}
// A message to a worker that is going (a jobs process stopped for a new release, an old web process) must not take
// main.js down: on 2026-11-16 a send to a dying jobs process threw ERR_IPC_CHANNEL_CLOSED and the machine restarted.
const send = (w, m) => {
  try {
    if (w && !w.isDead() && w.isConnected()) {
      w.send(m, (e) => e && console.log(`main: a message to a worker was lost (${e.code || e.message})`));
      return true;
    }
  } catch (e) {
    console.log(`main: a message to a worker was lost (${e.code || e.message})`);
  }
  return false;
};
const logDeploy = (w, row) => send(w, { type: "deploy-log", row: { sha: code.sha, ...row } });

// The code the site runs (release.js): a release on the volume put on this image, else the image's own.
const release = require("./release");
let code = release.current();
if (code.why) console.log(`main: the release is not used (${code.why}); the image's code starts`);
try {
  fs.mkdirSync(release.INCOMING, { recursive: true });
  release.writeJson(path.join(release.DIR, "main.json"), { pid: process.pid, image: release.IMAGE_SHA, at: new Date().toISOString() });
} catch (e) {
  console.log(`main: no releases folder: ${e.message}`);
}
console.log(`main: the site runs ${code.image ? "the image's code" : `release ${code.sha.slice(0, 7)}`}`);
let firstUp = false; // the first web process answered: a release that can't get this far is dropped
const fork = (env, on = code) => {
  cluster.setupPrimary({ exec: path.join(on.dir, "web", "server.js") });
  // DATA_DIR spelled out: a release elsewhere on disk must find the same database (Fly sets it; a laptop may not).
  return cluster.fork({ ...env, GIT_SHA: on.sha, IMAGE_SHA: release.IMAGE_SHA, DATA_DIR: process.env.DATA_DIR || path.join(release.IMAGE, "data") });
};

const RELOAD_QUIET = Number(process.env.CHYTAI_RELOAD_QUIET_MS) || 30 * 1000; // a burst of changes makes one reload
const RELOAD_GAP = Number(process.env.CHYTAI_RELOAD_GAP_MS) || 10 * 60 * 1000; // and reloads come at most this often

let web = null; // the worker answering the pages
let jobs = null;
let jobsReady = false;
let queue = []; // calls waiting for a jobs process (it is starting again)
let status = null; // the jobs side's last status, for a web process that starts later
let stopping = false;
let reloading = false;
let lastReload = 0;
let reloadTimer = null;

function startJobs() {
  jobsReady = false;
  jobs = fork({ CHYTAI_ROLE: "jobs" });
  // The jobs wait when the pages need the processor: both share the machine's two CPUs and Fly's CPU allowance.
  try {
    require("os").setPriority(jobs.process.pid, 10);
  } catch (e) {
    console.log(`main: could not lower the jobs' priority: ${e.message}`);
  }
  jobs.on("message", (m) => {
    if (m?.type === "ready") {
      jobsReady = true;
      for (const q of queue) send(jobs, q);
      queue = [];
    } else if (m?.type === "status") {
      status = m;
      for (const w of webs()) send(w, m);
    } else if (m?.type === "result") {
      send(cluster.workers[m.to], m);
    } else if (m?.type === "changed") {
      changed(m.what);
    }
  });
}

function startWeb(env = {}, on = code) {
  const w = fork({ CHYTAI_ROLE: "web", ...env }, on);
  w.on("message", (m) => {
    if (m?.type === "call") {
      const msg = { ...m, from: w.id };
      if (!(jobsReady && send(jobs, msg))) queue.push(msg);
    }
  });
  w.once("listening", () => status && send(w, status));
  return w;
}

const webs = () => Object.values(cluster.workers).filter((w) => w !== jobs);

// A job changed the shelves, the books or their details: a fresh web process reads them, then takes over.
function changed(what) {
  console.log(`main: the jobs changed ${what || "the data"}; the site reloads`);
  clearTimeout(reloadTimer);
  const wait = Math.max(RELOAD_QUIET, lastReload + RELOAD_GAP - Date.now());
  reloadTimer = setTimeout(reload, wait);
}

function reload() {
  if (stopping) return;
  if (reloading || switching) return void (reloadTimer = setTimeout(reload, RELOAD_QUIET));
  reloading = true;
  lastReload = Date.now();
  const old = web;
  const t0 = Date.now();
  const next = startWeb();
  const fail = () => ((reloading = false), console.log("main: the new web process died before it answered; the old one goes on"));
  next.once("exit", fail);
  next.once("listening", () => {
    next.off("exit", fail);
    web = next;
    reloading = false;
    console.log(`main: the new web process answers after ${Math.round((Date.now() - t0) / 1000)} s`);
    if (old && !old.isDead()) {
      send(old, { type: "shutdown" });
      setTimeout(() => !old.isDead() && old.kill(), 30 * 1000).unref();
    }
  });
}

// A worker's IPC error is logged, never thrown at main.js.
cluster.on("fork", (w) => w.on("error", (e) => console.log(`main: worker ${w.id}: ${e.code || e.message}`)));

cluster.on("exit", (w, exitCode, signal) => {
  if (stopping) return;
  if (w === jobs) {
    jobsReady = false;
    // A jobs process ends itself now and then to read fresh data (jobs.js); a crash is started again too.
    if (exitCode || signal) console.log(`main: the jobs process ended (${signal || exitCode}); starting it again`);
    setTimeout(startJobs, exitCode || signal ? 5000 : 0);
  } else if (w === web && !firstUp && !code.image) {
    // The release did not get as far as answering after a restart: the image's code, and the release forgotten.
    console.log(`main: release ${code.sha.slice(0, 7)} died before it answered (${signal || exitCode}); the image's code starts`);
    release.drop(code.sha, `died at start (${signal || exitCode})`);
    code = release.current();
    web = startWeb();
    web.once("listening", () => startJobs());
  } else if (w === web) {
    console.log(`main: the web process ended (${signal || exitCode}); starting it again`);
    const gone = Date.now();
    web = startWeb();
    web.once("listening", () => logDeploy(web, { kind: "web", how: String(signal || exitCode), down_ms: Date.now() - gone }));
  }
});

// A new release (hotdeploy.js asks with SIGHUP and request.json): a fresh web process on the new code listens first on a
// private port, where a few pages must open with 200, then on the site's port; the old one finishes what it has and
// goes, and the jobs process starts again on the new code. Anything wrong: the new process goes, the old stays.
const PROBE_PORT = Number(process.env.CHYTAI_PROBE_PORT) || 8079;
const PROBE_PAGES = ["/", "/robots.txt", `/search?q=${encodeURIComponent("кава")}`, "/calendar", "/lists", "/updates"];
let switching = false;
async function probe() {
  for (const p of PROBE_PAGES) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(`http://127.0.0.1:${PROBE_PORT}${p}`, { signal: ctl.signal, redirect: "manual", headers: { "user-agent": "chytai-release-check" } });
      const body = await r.text();
      if (r.status !== 200) return `${p}: HTTP ${r.status}`;
      if (!p.endsWith(".txt") && !body.includes("</html>")) return `${p}: no </html>`;
    } catch (e) {
      return `${p}: ${e.name === "AbortError" ? "no answer in 30 s" : e.message}`;
    } finally {
      clearTimeout(t);
    }
  }
  return "";
}
function hotSwitch() {
  const req = release.readJson(path.join(release.DIR, "request.json"));
  if (!req?.sha) return;
  if (switching || reloading) return void setTimeout(hotSwitch, 3000);
  const done = (r) => {
    switching = false;
    reloading = false;
    try {
      release.writeJson(path.join(release.DIR, `result-${req.sha}.json`), { ...r, sha: req.sha, at: new Date().toISOString() });
    } catch {}
    console.log(`main: release ${req.sha.slice(0, 7)}: ${r.ok ? `switched in ${Math.round(r.ms / 1000)} s` : r.why}`);
  };
  const next = release.ready(req.sha);
  if (!next.dir) return done({ ok: false, full: !!next.full, why: next.why });
  if (stopping) return done({ ok: false, full: true, why: "the machine is stopping" });
  switching = true;
  reloading = true; // no reload of the old code meanwhile
  const t0 = Date.now();
  const old = web;
  const prev = code;
  let over = false;
  const w = startWeb({ CHYTAI_PROBE_PORT: String(PROBE_PORT) }, next);
  const fail = (why) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (!w.isDead()) w.kill();
    done({ ok: false, why });
  };
  const timer = setTimeout(() => fail("the new code did not answer in 3 minutes"), 180000);
  w.once("exit", (c, sig) => fail(`the new code ended before it answered (${sig || c})`));
  w.on("message", async (m) => {
    if (m?.type !== "probe-ready" || over) return;
    const bad = await probe();
    if (bad) return fail(`a page did not open: ${bad}`);
    send(w, { type: "go" });
  });
  w.on("listening", (a) => {
    if (a?.port !== Number(process.env.PORT || 8090) || over) return;
    over = true;
    clearTimeout(timer);
    w.removeAllListeners("exit");
    code = next;
    web = w;
    firstUp = true;
    try {
      release.setCurrent(next.sha, prev.sha);
    } catch (e) {
      console.log(`main: could not keep current.json: ${e.message}`);
    }
    if (old && !old.isDead()) {
      send(old, { type: "shutdown" });
      setTimeout(() => !old.isDead() && old.kill(), 30 * 1000).unref();
    }
    // The jobs on the new code too (what they were doing stops, as at any deploy).
    if (jobs && !jobs.isDead()) {
      jobsReady = false; // calls wait in the queue for the new jobs process
      jobs.process.kill("SIGTERM");
    }
    const ms = Date.now() - t0;
    logDeploy(w, { kind: "switch", how: "hot", down_ms: 0, boot_ms: ms, note: `з ${prev.sha.slice(0, 7)}` });
    done({ ok: true, ms, prev: prev.sha });
  });
}
process.on("SIGHUP", hotSwitch);

// `kill -USR2 <pid of main.js>` (fly ssh console) reloads the site by hand.
process.on("SIGUSR2", () => changed("by hand"));

for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    if (!stopping)
      try {
        fs.writeFileSync(STOP_FILE, JSON.stringify({ at: new Date().toISOString(), sig, sha: code.sha }));
      } catch {}
    stopping = true;
    for (const w of Object.values(cluster.workers)) w.process.kill(sig);
    setTimeout(() => process.exit(0), 8000).unref();
    let left = Object.keys(cluster.workers).length;
    if (!left) process.exit(0);
    cluster.on("exit", () => --left <= 0 && process.exit(0));
  });

// The web process opens the database first (db.js adds missing columns; two at once would both try), then the jobs.
web = startWeb();
web.once("listening", () => {
  firstUp = true;
  const now = Date.now();
  const stop = lastStop && now - Date.parse(lastStop.at) < 30 * 60000 ? lastStop : null;
  logDeploy(web, { kind: "restart", how: stop ? "stop" : "crash", down_ms: stop ? now - Date.parse(stop.at) : null, boot_ms: now - STARTED, note: stop ? `${stop.sig}, ${(stop.sha || "").slice(0, 7)}` : "" });
  startJobs();
});
