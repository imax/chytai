// How long the site did not answer around deploys and restarts (Max, 2026-11-16: «давай почнемо, щоб розуміти, чи
// дійсно стало краще і чи дійсно зменшився даунтайм»). Two views of the same pause, kept in table `deploys`:
//   - kind 'restart' / 'web' from main.js: the machine (or the web process alone) went down and came back.
//     down_ms = from the stop signal (main.js keeps it in main-stop.json across the restart) to the first page
//     answered; boot_ms = from main.js starting to that answer. how = 'stop' (Fly stopped it: a deploy, a secret, a
//     move), 'crash' (no stop signal seen) or the web process's exit code.
//   - kind 'probe' from web.yml (scripts/deploy-probe.sh): a GitHub runner asks /robots.txt every second through the
//     deploy, as a visitor would. down_ms = the longest stretch with no answer in 5 s; fails = probes with none;
//     fly_errors = requests Fly's proxy could not deliver in that time (fly_edge_error_count), when the token sees it.
// /admin/speed «Деплої» shows them. Kept 180 days.
let db = null;
const KEEP_DAYS = 180;

function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS deploys (at TEXT NOT NULL, kind TEXT NOT NULL, sha TEXT NOT NULL DEFAULT '',
    how TEXT NOT NULL DEFAULT '', down_ms INTEGER, boot_ms INTEGER, fails INTEGER, fly_errors INTEGER, note TEXT NOT NULL DEFAULT '')`);
  db.exec("CREATE INDEX IF NOT EXISTS deploys_at ON deploys (at)");
}

const int = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));

function add(r = {}) {
  if (!db) return null;
  const kind = ["restart", "web", "probe", "hot"].includes(r.kind) ? r.kind : null;
  if (!kind) throw new Error("kind: restart | web | probe | hot");
  const at = r.at && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
  const row = { at, kind, sha: String(r.sha || "").slice(0, 40), how: String(r.how || "").slice(0, 40), down_ms: int(r.down_ms), boot_ms: int(r.boot_ms), fails: int(r.fails), fly_errors: int(r.fly_errors), note: String(r.note || "").slice(0, 300) };
  db.prepare("INSERT INTO deploys (at, kind, sha, how, down_ms, boot_ms, fails, fly_errors, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.at, row.kind, row.sha, row.how, row.down_ms, row.boot_ms, row.fails, row.fly_errors, row.note);
  db.prepare("DELETE FROM deploys WHERE at < ?").run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
  return row;
}

// The last `days` days: { rows (newest first, at most 40), days: [[kyivDay, { deploys, down, longest, flyErrors }]] }.
// A day's numbers come from the probes (what a visitor saw); restarts with no probe (a crash, a deploy by hand) add
// their server-side pause.
function recent(days = 14) {
  if (!db) return { rows: [], days: [] };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const all = db.prepare("SELECT * FROM deploys WHERE at >= ? ORDER BY at DESC").all(since);
  const kyiv = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const byDay = new Map();
  const probes = all.filter((r) => r.kind === "probe" || r.kind === "hot");
  for (const r of all) {
    const d = kyiv(r.at);
    if (!byDay.has(d)) byDay.set(d, { deploys: 0, hot: 0, down: 0, longest: 0, flyErrors: 0, restarts: 0, serverDown: 0 });
    const k = byDay.get(d);
    if (r.kind === "probe" || r.kind === "hot") {
      k.deploys++;
      if (r.kind === "hot") k.hot++;
      k.down += r.down_ms || 0;
      k.longest = Math.max(k.longest, r.down_ms || 0);
      k.flyErrors += r.fly_errors || 0;
    } else {
      k.restarts++;
      k.serverDown += r.down_ms || 0;
      // A restart no probe watched (a crash, a deploy from a laptop): its pause counts too.
      const t = Date.parse(r.at);
      if (!probes.some((p) => Math.abs(Date.parse(p.at) - t) < 10 * 60000)) k.down += r.down_ms || 0;
    }
  }
  return { rows: all.slice(0, 40), days: [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)) };
}

module.exports = { init, add, recent };
