// Runs ON a Fly machine (sent there by .github/workflows/backup.yml): packs a data directory into one
// .tar.gz. SQLite files (the site's web/chytai.db, the reader's reader.db since 2026-11-05) are copied with VACUUM INTO,
// so the copy is consistent even while the app writes;
// everything else is taken as is.
//   node backup-snapshot.js <data dir> <out.tar.gz> [exclude ...]
// Plain Node 22 (node:sqlite) and tar, both already in the app images.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const [src, out, ...excludes] = process.argv.slice(2);
const tmp = fs.mkdtempSync("/tmp/chytai-backup-");
fs.chmodSync(tmp, 0o755);
const skip = (rel) => excludes.some((e) => rel === e || rel.startsWith(e + "/"));

function walk(dir, rel = "") {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (e.name.endsWith(".db")) {
      const { DatabaseSync } = require("node:sqlite");
      fs.mkdirSync(path.dirname(path.join(tmp, r)), { recursive: true });
      const db = new DatabaseSync(path.join(dir, e.name));
      db.exec(`VACUUM INTO '${path.join(tmp, r).replace(/'/g, "''")}'`);
      db.close();
      console.log(`snapshot ${r}`);
    }
  }
}
walk(src);

// Two passes: an --exclude would also drop the snapshots if they went in with the same command.
const tarFile = out.replace(/\.gz$/, "");
// The app keeps writing meanwhile (readers in the morning, 2026-11-05: «tar: .: file changed as we read it»
// failed the night's reader backup). GNU tar then exits with 1, which only means «something changed while
// read»: each file still went in whole (the app writes its JSON to a new file and renames it), and the
// workflow's check parses every JSON. Only exit 2 and up is a real failure.
try {
  execFileSync("tar", [
    "cf", tarFile, "--warning=no-file-changed", "--warning=no-file-removed",
    "--exclude=*.db", "--exclude=*.db-wal", "--exclude=*.db-shm",
    ...excludes.map((e) => `--exclude=./${e}`),
    "-C", src, ".",
  ]);
} catch (e) {
  if (e.status !== 1) throw e;
  console.log("tar: some files changed while read (kept as read)");
}
execFileSync("tar", ["rf", tarFile, "-C", tmp, "."]);
execFileSync("gzip", ["-f", tarFile]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out} ${fs.statSync(out).size} bytes`);
