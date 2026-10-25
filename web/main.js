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

cluster.setupPrimary({ exec: path.join(__dirname, "server.js") });

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
  jobs = cluster.fork({ CHYTAI_ROLE: "jobs" });
  // The jobs wait when the pages need the processor: both share the machine's two CPUs and Fly's CPU allowance.
  try {
    require("os").setPriority(jobs.process.pid, 10);
  } catch (e) {
    console.log(`main: could not lower the jobs' priority: ${e.message}`);
  }
  jobs.on("message", (m) => {
    if (m?.type === "ready") {
      jobsReady = true;
      for (const q of queue) jobs.send(q);
      queue = [];
    } else if (m?.type === "status") {
      status = m;
      for (const w of webs()) w.send(m);
    } else if (m?.type === "result") {
      cluster.workers[m.to]?.send(m);
    } else if (m?.type === "changed") {
      changed(m.what);
    }
  });
}

function startWeb() {
  const w = cluster.fork({ CHYTAI_ROLE: "web" });
  w.on("message", (m) => {
    if (m?.type === "call") {
      const msg = { ...m, from: w.id };
      if (jobs && jobsReady) jobs.send(msg);
      else queue.push(msg);
    }
  });
  w.once("listening", () => status && w.send(status));
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
  if (reloading) return void (reloadTimer = setTimeout(reload, RELOAD_QUIET));
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
      old.send({ type: "shutdown" });
      setTimeout(() => !old.isDead() && old.kill(), 30 * 1000).unref();
    }
  });
}

cluster.on("exit", (w, code, signal) => {
  if (stopping) return;
  if (w === jobs) {
    // A jobs process ends itself now and then to read fresh data (jobs.js); a crash is started again too.
    if (code || signal) console.log(`main: the jobs process ended (${signal || code}); starting it again`);
    setTimeout(startJobs, code || signal ? 5000 : 0);
  } else if (w === web) {
    console.log(`main: the web process ended (${signal || code}); starting it again`);
    web = startWeb();
  }
});

// `kill -USR2 <pid of main.js>` (fly ssh console) reloads the site by hand.
process.on("SIGUSR2", () => changed("by hand"));

for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    stopping = true;
    for (const w of Object.values(cluster.workers)) w.process.kill(sig);
    setTimeout(() => process.exit(0), 8000).unref();
    let left = Object.keys(cluster.workers).length;
    if (!left) process.exit(0);
    cluster.on("exit", () => --left <= 0 && process.exit(0));
  });

// The web process opens the database first (db.js adds missing columns; two at once would both try), then the jobs.
web = startWeb();
web.once("listening", startJobs);
