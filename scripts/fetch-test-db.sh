#!/bin/sh
# Puts last night's test copy of the site's database (chytai-web) into data/web/, where the site looks for it
# by default (DATA_DIR=./data). The copy is made by .github/workflows/backup.yml: real emails, sessions,
# tokens and secrets are taken out (scripts/test-db-scrub.py). Log in to a test account by email code: the
# addresses are <reader id>@test.invalid (e.g. owner@test.invalid), and without RESEND_API_KEY the code goes
# to the log. Any database already there is kept as chytai.db.bak-<date>.
#   scripts/fetch-test-db.sh [data dir]
# The age key: $CHYTAI_BACKUP_KEY, or the project files, or .backup-key in the repo (Max's Mac).
# The covers (~140 MB, made weekly apart from the database since 2026-11-11) come too, once: not again while
# data/web/covers already holds some, nor with CHYTAI_TEST_COVERS=0 (the smoke test); =1 fetches them anew.
set -e
cd "$(dirname "$0")/.."
data=${1:-data}
url=${CHYTAI_TEST_DB_URL:-https://github.com/imax/chytai/releases/download/test-db/chytai-web-test.tar.gz.age}
key=${CHYTAI_BACKUP_KEY:-}
for k in /mnt/project-files/chytai-backup/backup-key.txt .backup-key "$HOME/Projects/chytai/.backup-key"; do
  [ -z "$key" ] && [ -s "$k" ] && key=$k
done
[ -n "$key" ] || { echo "No age key: set CHYTAI_BACKUP_KEY (see README, «Бекапи»)" >&2; exit 1; }
command -v age >/dev/null || { echo "age is not installed (brew install age / apt-get install age)" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/test.tar.gz.age" "$url"
age -d -i "$key" -o "$tmp/test.tar.gz" "$tmp/test.tar.gz.age"
mkdir -p "$tmp/x" && tar xzf "$tmp/test.tar.gz" -C "$tmp/x"

mkdir -p "$data/web"
if [ -f "$data/web/chytai.db" ]; then mv "$data/web/chytai.db" "$data/web/chytai.db.bak-$(date +%Y%m%d-%H%M%S)"; fi
rm -f "$data/web/chytai.db-wal" "$data/web/chytai.db-shm"
mv "$tmp/x/web/chytai.db" "$data/web/chytai.db"
if [ -d "$tmp/x/web/covers" ]; then mkdir -p "$data/web/covers" && cp -R "$tmp/x/web/covers/." "$data/web/covers/"; fi
have=$(find "$data/web/covers" -maxdepth 1 -type f 2>/dev/null | wc -l)
if [ "${CHYTAI_TEST_COVERS:-}" != 0 ] && { [ "$have" -lt 100 ] || [ "${CHYTAI_TEST_COVERS:-}" = 1 ]; }; then
  if curl -fsSL -o "$tmp/covers.tar.gz.age" "${url%/*}/chytai-web-covers.tar.gz.age"; then
    rm -rf "$tmp/x" "$tmp/test.tar.gz"
    age -d -i "$key" "$tmp/covers.tar.gz.age" | { mkdir -p "$data/web/covers" && tar xzf - -C "$data/web/covers"; }
    echo "covers: $(find "$data/web/covers" -maxdepth 1 -type f | wc -l)"
  else
    echo "no covers copy yet (made on Sundays): the pages show coloured blocks" >&2
  fi
fi
python3 -c "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(sys.argv[1], 'made', d.execute(\"select value from meta where key='testdb:made'\").fetchone()[0], {t: d.execute(f'select count(*) from {t}').fetchone()[0] for t in ['readers','entries','books','items']})" "$data/web/chytai.db"
