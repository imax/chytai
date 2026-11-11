#!/usr/bin/env bash
# The nightly trial restore (Max, 2026-11-11: «перевіряти, що бекап кожну ніч працює»). backup.yml runs it on the
# artifact it has just uploaded, downloaded back from GitHub: it decrypts it with the private age key (repo secret
# CHYTAI_BACKUP_KEY), checks it is byte for byte the copy taken on the machine, unpacks it and starts the app on it,
# the way a real restore would:
#   chytai-web: web/server.js (CHYTAI_ROLE=web: no jobs, mail or Telegram) opens its main pages and Max's profile;
#   chytai:     server/index.js reads its accounts back (a reader's /api/settings comes with their username);
#   chytai-web-covers (weekly): every file is a picture.
# Prints only counts, never names or addresses (the Actions log is public). Outbound calls go nowhere (WEB_URL).
# Usage: scripts/backup-restore-check.sh <chytai-web | chytai | chytai-web-covers> <file.tar.gz.age> <the backup.tar.gz taken>
# Env: CHYTAI_BACKUP_KEY (path of the age key file). Run from the repo root after npm ci.
set -u
APP=$1 AGE=$2 ORIG=$3
PORT=${RESTORE_PORT:-8097}
BASE="http://localhost:$PORT"
DIR=$(mktemp -d)
pid=
trap '[ -n "$pid" ] && kill $pid 2>/dev/null; rm -rf "$DIR"' EXIT
die() { echo "::error::restore check: $*"; [ -s "$DIR/log" ] && tail -30 "$DIR/log"; exit 1; }

[ -s "${CHYTAI_BACKUP_KEY:-}" ] || die "no age key (CHYTAI_BACKUP_KEY)"
age -d -i "$CHYTAI_BACKUP_KEY" -o "$DIR/b.tar.gz" "$AGE" || die "the artifact does not decrypt with the key we hold"
cmp -s "$DIR/b.tar.gz" "$ORIG" || die "the decrypted copy is not the one taken on the machine"
mkdir "$DIR/data" && tar xzf "$DIR/b.tar.gz" -C "$DIR/data" || die "the copy does not unpack"
rm "$DIR/b.tar.gz"
echo "decrypted and unpacked: $(find "$DIR/data" -type f | wc -l) files, $(du -sh "$DIR/data" | cut -f1)"

up() { # <path that answers once the server is up>
  for _ in $(seq 1 120); do
    curl -s -o /dev/null "$BASE$1" && return 0
    kill -0 $pid 2>/dev/null || break
    sleep 0.5
  done
  die "the server did not start on the restored data"
}
get() { # <path> [cookie] → body in $DIR/page, fails unless 200
  local code
  code=$(curl -s -o "$DIR/page" -w "%{http_code}" -m 30 ${2:+-b "$2"} "$BASE$1" || echo 000)
  [ "$code" = 200 ] || die "$1: HTTP $code"
  echo "ok   $1"
}

if [ "$APP" = chytai-web-covers ]; then
  # Pictures only: every file is a JPEG, PNG, WebP, GIF or AVIF by its first bytes, none empty.
  node --no-warnings -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1]; let n = 0, bad = 0;
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f);
      if (!fs.statSync(p).isFile()) continue;
      const b = fs.readFileSync(p).subarray(0, 12);
      const pic = (b[0] === 0xff && b[1] === 0xd8) || b.subarray(1, 4).toString() === "PNG" || b.subarray(8, 12).toString() === "WEBP" || b.subarray(0, 3).toString() === "GIF" || b.subarray(4, 12).toString().startsWith("ftypavi");
      n++; if (!pic) bad++;
    }
    console.log(`covers in the copy: ${n}, not pictures: ${bad}`);
    process.exit(n >= 10 && bad === 0 ? 0 : 1);
  ' "$DIR/data" || die "the covers are not all pictures"
  echo "restore check: fine"
  exit 0
elif [ "$APP" = chytai-web ]; then
  [ -s "$DIR/data/web/chytai.db" ] || die "no web/chytai.db in the copy"
  CHYTAI_ROLE=web PORT=$PORT DATA_DIR="$DIR/data" node web/server.js >"$DIR/log" 2>&1 &
  pid=$!
  up /robots.txt
  for p in / /community /lists /@maxua; do
    get "$p"
    grep -qi "</html>" "$DIR/page" || die "$p stops before </html>"
  done
  echo "readers in the copy: $(node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare("select count(*) n from readers").get().n)' "$DIR/data/web/chytai.db")"
else
  [ -s "$DIR/data/reader.db" ] || die "no reader.db in the copy"
  # Up to three accounts with a username (from the copy itself), each with a cookie signed by our own secret.
  accts=$(node --no-warnings -e '
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    const all=db.prepare("select id, value from docs where coll = ?").all("accounts").map(r=>({id:r.id,...JSON.parse(r.value)}));
    console.error(`accounts in the copy: ${all.length}`);
    for (const a of all.filter(a=>a.username&&!a.legacyOff&&/^[a-f0-9]{16}$/.test(a.id)).slice(0,3)) console.log(a.id, a.username);
  ' "$DIR/data/reader.db") || die "reader.db does not read"
  [ -n "$accts" ] || die "no account with a username in the copy"
  READER_SECRET=restore-check WEB_URL=http://127.0.0.1:9 ANTHROPIC_API_KEY= PORT=$PORT DATA_DIR="$DIR/data" node server/index.js >"$DIR/log" 2>&1 &
  pid=$!
  up /login
  get /login
  n=0
  while read -r id name; do
    sig=$(printf 'acct:%s' "$id" | openssl dgst -sha256 -hmac restore-check -binary | base64 | tr '+/' '-_' | tr -d '=')
    get /api/settings "reader_acct=$id.$sig"
    [ "$(jq -r .username "$DIR/page")" = "$name" ] || die "an account's settings came back without its own username"
    n=$((n + 1))
  done <<<"$accts"
  echo "ok   $n accounts read back from the copy"
fi

if grep -nE "^(TypeError|ReferenceError|SyntaxError|RangeError)|    at " "$DIR/log" | head -10 | grep .; then die "errors in the server log"; fi
kill -0 $pid 2>/dev/null || die "the server died"
echo "restore check: fine"
