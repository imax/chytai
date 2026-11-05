// Disk and memory of this app's machine (scaling review 2026-11-05, Max: «робимо всі 5 пунктів»): for the
// Performance block on /admin, and a Telegram message to the owner when one of them comes near its limit.
// The reader has the same file (server/storage.js); the two apps are built from different folders.
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");

const LIMITS = { disk: 0.8, memory: 0.8, heap: 0.85 }; // a share of the whole past which it is red

// dbFiles: the database files to count, relative to dir.
function now(dir, dbFiles = []) {
  const out = {};
  try {
    const st = fs.statfsSync(dir);
    out.diskTotal = st.blocks * st.bsize;
    out.diskFree = st.bavail * st.bsize;
  } catch {}
  out.db = 0;
  for (const f of dbFiles) for (const x of [f, `${f}-wal`]) try { out.db += fs.statSync(path.join(dir, x)).size; } catch {}
  const m = process.memoryUsage();
  out.rss = m.rss;
  out.memTotal = os.totalmem();
  out.heap = m.heapUsed;
  out.heapLimit = v8.getHeapStatistics().heap_size_limit;
  return out;
}

// What is near its limit, in words for the owner: [] when nothing is.
function problems(s, where) {
  if (!s) return [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const mb = (n) => `${Math.round(n / 1048576)} МБ`;
  const out = [];
  if (s.diskTotal && 1 - s.diskFree / s.diskTotal > LIMITS.disk) out.push(`${where}: диск зайнятий на ${pct(1 - s.diskFree / s.diskTotal)} (вільно ${mb(s.diskFree)})`);
  if (s.memTotal && s.rss / s.memTotal > LIMITS.memory) out.push(`${where}: процес займає ${mb(s.rss)} з ${mb(s.memTotal)} пам'яті`);
  if (s.heapLimit && s.heap / s.heapLimit > LIMITS.heap) out.push(`${where}: дані в пам'яті ${mb(s.heap)} з дозволених ${mb(s.heapLimit)}`);
  return out;
}

// Every `minutes` checks `get()` (-> [problem text]) and sends what is new to `send(subject, text)`; the same
// problem again at most once in 12 hours.
function watch(get, send, minutes = 10) {
  const sent = new Map();
  const tick = async () => {
    try {
      for (const p of (await get()) || []) {
        const key = p.replace(/\d+/g, "N");
        if (Date.now() - (sent.get(key) || 0) < 12 * 3600000) continue;
        sent.set(key, Date.now());
        send("Chytai: закінчується місце чи пам'ять", p);
      }
    } catch (err) {
      console.error("storage watch:", err.message);
    }
  };
  setTimeout(tick, 60000).unref();
  setInterval(tick, minutes * 60000).unref();
}

module.exports = { now, problems, watch, LIMITS };
