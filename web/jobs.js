// The background jobs' side of server.js (main.js has the why). server.js builds the same objects in both
// processes; this file decides who does the work:
// - in the jobs process (CHYTAI_ROLE=jobs) the jobs run, on a schedule kept in the database (`sched:<name>`
//   in meta, so a restart does not start them again), or when the site asks; what runs goes to the site
//   every two seconds, and a finished job that changed the pages asks main.js for a fresh web process;
// - in the web process (CHYTAI_ROLE=web) the same methods only send the request to the jobs process, and
//   `running` comes from its status;
// - with no role (`node web/server.js`, local runs) everything stays in one process, as before.
const ROLE = process.env.CHYTAI_ROLE || "all";
const background = ROLE !== "web"; // this process runs the jobs
const serving = ROLE !== "jobs"; // this process answers the pages

const registry = new Map(); // name -> { obj, methods: { method: reload? } }
let remote = {}; // the jobs process's status as the web process last heard it: name -> { running, allRunning, ... }
const waiting = new Map(); // call id -> resolve, in the web process
let nextId = 1;

// What ran and how it went, for /admin/jobs: one row per run in `job_runs` (db.js), a month of them kept.
// `via` says who starts the call made right now (the schedule, the site); a call nobody stands behind is
// the process's own (a run cut by a restart going on). ok: 1 fine, 2 with errors on the way, 0 failed. A run
// that found nothing to do (null, false or 0, under 2 s) is not written down: the refresh is asked every ten minutes and works once a day.
let runsDb = null;
let via = null;
let calls = 0; // runs written down, so a schedule knows whether it called a job or did the work itself
let pruned = 0;
function remember(job, how, t0, ok, r) {
  const ms = Date.now() - t0;
  if (!runsDb || (ok && (r == null || r === false || r === 0) && ms < 2000)) return;
  try {
    runsDb.prepare("INSERT INTO job_runs (job, how, started, ms, ok, note) VALUES (?, ?, ?, ?, ?, ?)").run(job, how || "", new Date(t0).toISOString(), ms, !ok || r?.ok === false ? 0 : r?.errors?.length ? 2 : 1, ok ? summary(r) : String(r?.message || r).slice(0, 300));
    if (Date.now() - pruned > 3600 * 1000) {
      pruned = Date.now();
      runsDb.prepare("DELETE FROM job_runs WHERE started < ?").run(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
    }
  } catch (e) {
    console.log(`jobs: could not write down ${job}: ${e.message}`);
  }
}
// A job's answer in a line: a number, a word, or the plain fields of what it returned and its first error.
function summary(r) {
  if (r == null || r === true) return "";
  if (r === false) return "без змін";
  if (typeof r !== "object") return String(r).slice(0, 300);
  if (typeof r.note === "string") return r.note.slice(0, 300);
  const errors = Array.isArray(r.errors) ? r.errors : [];
  const plain = Object.entries(r).filter(([k, v]) => !["ok", "changed", "started", "finished", "at", "log"].includes(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 60)));
  const parts = plain.slice(0, 6).map(([k, v]) => `${k}: ${v}`);
  if (errors.length) parts.push(`помилок ${errors.length}: ${String(errors[0]?.message || errors[0]).slice(0, 150)}`);
  return parts.join(", ").slice(0, 300);
}

// Put an object's jobs under a name. methods: { run: true } — true when a finished run changed what the
// pages show (the site then reloads, unless the run says { changed: false }); `extra` names fields to report besides running/allRunning.
// mirror: false keeps the object's own `running` in the web process (advice counts its own requests there).
// quiet: methods not written down on /admin/jobs (a reader's rating queues an overview: many a day).
function register(name, obj, methods, extra = [], { mirror = true, quiet = [] } = {}) {
  registry.set(name, { obj, methods, extra });
  if (ROLE === "web") {
    for (const m of Object.keys(methods)) obj[m] = (...args) => call(name, m, args);
    if (mirror) for (const f of ["running", "allRunning", ...extra]) Object.defineProperty(obj, f, { configurable: true, get: () => remote[name]?.[f] });
  } else {
    for (const [m, reload] of Object.entries(methods)) {
      const own = obj[m].bind(obj);
      const job = `${name}.${m}`;
      obj[m] = (...args) => {
        const how = via;
        const t0 = Date.now();
        const p = Promise.resolve(own(...args));
        if (!quiet.includes(m)) (calls++, p.then((r) => remember(job, how, t0, true, r), (e) => remember(job, how, t0, false, e)));
        if (reload && ROLE === "jobs") p.then((r) => r !== false && r !== null && r?.ok !== false && r?.changed !== false && changed(job), () => {});
        return p;
      };
    }
  }
  return obj;
}

// A function as a job of its own (the catalog refresh): the same in all three cases.
function fn(name, f, reload, state = () => ({})) {
  let n = 0; // runs in flight, so the jobs process does not end in the middle of one
  const obj = { run: (...args) => (n++, Promise.resolve(f(...args)).finally(() => n--)), state, own: true, get running() { return n > 0; } };
  register(name, obj, { run: reload });
  return (...args) => obj.run(...args);
}

function call(name, method, args) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    process.send({ type: "call", id, name, method, args: JSON.parse(JSON.stringify(args ?? [])) });
  });
}

function changed(what) {
  if (ROLE === "jobs") process.send({ type: "changed", what });
}

// ---- the jobs process ----
// Due-based schedules: `every` ms after the last start (kept in meta), checked each minute; `first` waits
// that long after this process starts (the site is up and reading before the jobs begin). The web process
// keeps the list too, for /admin/jobs, and runs none of them.
const schedules = [];
function every(name, ms, f, { db, first = 60 * 1000 } = {}) {
  schedules.push({ name, ms, f, db, first, after: Date.now() + first });
}
let schedRunning = new Set();
function tick() {
  for (const s of schedules) {
    if (Date.now() < s.after || schedRunning.has(s.name)) continue;
    const last = Date.parse(s.db.get(`sched:${s.name}`) || "") || 0;
    if (Date.now() - last < s.ms) continue;
    s.db.set(`sched:${s.name}`, new Date().toISOString());
    schedRunning.add(s.name);
    // A schedule that calls a job leaves the writing down to it; one that does the work itself (thumbs) is written down here.
    const t0 = Date.now();
    const before = calls;
    via = "розклад";
    let p;
    try {
      p = Promise.resolve(s.f());
    } catch (e) {
      p = Promise.reject(e);
    }
    via = null;
    const own = calls === before;
    p.then((r) => own && remember(s.name, "розклад", t0, true, r))
      .catch((e) => (own && remember(s.name, "розклад", t0, false, e), console.log(`${s.name}: ${e.message}`)))
      .finally(() => schedRunning.delete(s.name));
  }
}

function snapshot() {
  const out = {};
  for (const [name, { obj, extra }] of registry) {
    out[name] = { running: !!obj.running, allRunning: !!obj.allRunning };
    for (const f of extra) out[name][f] = obj[f];
    if (obj.own) Object.assign(out[name], obj.state());
  }
  return out;
}
const born = Date.now();
// The process itself, for /admin/jobs (memory in steps of 10 MB, so the status does not change every time).
const self = () => ({ sched: [...schedRunning], born: new Date(born).toISOString(), mb: Math.round(process.memoryUsage().rss / 10485760) * 10 });
const busy = () => schedRunning.size > 0 || Object.values(snapshot()).some((s) => s.running || s.allRunning);

// The jobs process keeps its own copy of the data, read at its start, and readers change theirs all day:
// once nothing runs and the copy is two hours old it ends, and main.js starts a fresh one. idle() says
// whether other work (the overview queue) is waiting.
function startJobs({ idle = () => true, db = null } = {}) {
  if (!background) return;
  runsDb = db;
  if (ROLE !== "jobs") return void setInterval(tick, 60 * 1000).unref();
  process.on("message", async (m) => {
    if (m?.type !== "call") return;
    const job = registry.get(m.name);
    let value = null;
    let ok = true;
    try {
      if (!job || !(m.method in job.methods)) throw new Error(`no job ${m.name}.${m.method}`);
      via = "сайт";
      const p = job.obj[m.method](...(m.args || []));
      via = null;
      value = await p;
    } catch (e) {
      via = null;
      ok = false;
      value = e.message;
    }
    try {
      process.send({ type: "result", to: m.from, id: m.id, ok, value: JSON.parse(JSON.stringify(value ?? null)) });
    } catch {
      process.send({ type: "result", to: m.from, id: m.id, ok, value: null });
    }
  });
  let last = "";
  setInterval(() => {
    const s = JSON.stringify({ ...snapshot(), "@": self() });
    if (s !== last) process.send({ type: "status", jobs: JSON.parse(s) });
    last = s;
  }, 2000).unref();
  setInterval(() => {
    tick();
    if (Date.now() - born > 2 * 3600 * 1000 && !busy() && idle()) {
      console.log("jobs: two hours on the same data and nothing running; starting afresh");
      process.exit(0);
    }
  }, 60 * 1000).unref();
  process.send({ type: "ready" });
}

// ---- the web process ----
if (ROLE === "web")
  process.on("message", (m) => {
    if (m?.type === "status") remote = m.jobs || {};
    else if (m?.type === "result") {
      waiting.get(m.id)?.(m.value);
      waiting.delete(m.id);
    }
  });
const status = (name) => remote[name] || {};

// For /admin/jobs: what runs now (the jobs process's status, or this process's own), the schedules with
// their last start, and the runs written down.
function overview(db) {
  const live = ROLE === "web" ? remote : { ...snapshot(), "@": self() };
  const plans = schedules.map((s) => ({ name: s.name, ms: s.ms, first: s.first, last: db.get(`sched:${s.name}`) || null }));
  const recent = db.prepare("SELECT job, how, started, ms, ok, note FROM job_runs ORDER BY started DESC LIMIT 60").all();
  const last = db.prepare("SELECT job, how, max(started) AS started, ms, ok, note FROM job_runs GROUP BY job").all();
  const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const counts = db.prepare("SELECT job, count(*) AS n, sum(ok = 0) AS failed, sum(ms) AS ms FROM job_runs WHERE started >= ? GROUP BY job").all(week);
  return { role: ROLE, live, plans, recent, last, counts };
}

module.exports = { ROLE, background, serving, register, fn, every, startJobs, status, changed, overview };
