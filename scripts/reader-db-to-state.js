// Only for going back to a reader from before reader.db (2026-11-05): writes DATA_DIR/state.json from the database,
// in the shape the old server/index.js reads. Run it on the machine before deploying the old version:
//   fly ssh console -a chytai -C "node /app/scripts/reader-db-to-state.js /data"
const fs = require("fs");
const path = require("path");
const dir = process.argv[2] || "/data";
const store = require(path.join(__dirname, "..", "server", "db.js")).open(dir);
if (!store.migrated()) throw new Error("reader.db has no data yet: state.json is still the one in use");
const state = store.loadState();
for (const kind of store.KINDS) {
  for (const { acct } of store.db.prepare("SELECT DISTINCT acct FROM items WHERE kind = ?").all(kind)) {
    ((state.users ??= {})[acct] ??= {})[kind] = store.items.books(acct, kind);
  }
}
const file = path.join(dir, "state.json");
if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.old-${Date.now()}`);
fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
fs.renameSync(`${file}.tmp`, file);
console.log(`state.json written: ${Object.keys(state.users || {}).length} readers`);
