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

// Put an object's jobs under a name. methods: { run: true } — true when a finished run changed what the
// pages show (the site then reloads); `extra` names fields to report besides running/allRunning.
// mirror: false keeps the object's own `running` in the web process (advice counts its own requests there).
function register(name, obj, methods, extra = [], { mirror = true } = {}) {
  registry.set(name, { obj, methods, extra });
  if (ROLE === "web") {
    for (const m of Object.keys(methods)) obj[m] = (...args) => call(name, m, args);
    if (mirror) for (const f of ["running", "allRunning", ...extra]) Object.defineProperty(obj, f, { configurable: true, get: () => remote[name]?.[f] });
  } else if (ROLE === "jobs") {
    for (const [m, reload] of Object.entries(methods)) {
      const own = obj[m].bind(obj);
      obj[m] = (...args) => {
        const p = Promise.resolve(own(...args));
        if (reload) p.then((r) => r !== false && r !== null && r?.ok !== false && changed(`${name}.${m}`), () => {});
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
// that long after this process starts (the site is up and reading before the jobs begin).
const schedules = [];
function every(name, ms, f, { db, first = 60 * 1000 } = {}) {
  if (!background) return;
  schedules.push({ name, ms, f, db, after: Date.now() + first });
}
let schedRunning = new Set();
function tick() {
  for (const s of schedules) {
    if (Date.now() < s.after || schedRunning.has(s.name)) continue;
    const last = Date.parse(s.db.get(`sched:${s.name}`) || "") || 0;
    if (Date.now() - last < s.ms) continue;
    s.db.set(`sched:${s.name}`, new Date().toISOString());
    schedRunning.add(s.name);
    Promise.resolve()
      .then(s.f)
      .catch((e) => console.log(`${s.name}: ${e.message}`))
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
const busy = () => schedRunning.size > 0 || Object.values(snapshot()).some((s) => s.running || s.allRunning);

// The jobs process keeps its own copy of the data, read at its start, and readers change theirs all day:
// once nothing runs and the copy is two hours old it ends, and main.js starts a fresh one. idle() says
// whether other work (the overview queue) is waiting.
function startJobs({ idle = () => true } = {}) {
  if (!background) return;
  if (ROLE !== "jobs") return void setInterval(tick, 60 * 1000).unref();
  const born = Date.now();
  process.on("message", async (m) => {
    if (m?.type !== "call") return;
    const job = registry.get(m.name);
    let value = null;
    let ok = true;
    try {
      if (!job || !(m.method in job.methods)) throw new Error(`no job ${m.name}.${m.method}`);
      value = await job.obj[m.method](...(m.args || []));
    } catch (e) {
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
    const s = JSON.stringify(snapshot());
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

module.exports = { ROLE, background, serving, register, fn, every, startJobs, status, changed };
