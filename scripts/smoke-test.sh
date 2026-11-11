#!/usr/bin/env bash
# Smoke test of the site before it deploys (Max, 2026-11-04, after the two-week review: no tests at all,
# hundreds of deploys). Starts web/server.js on its own (CHYTAI_ROLE=web: no background jobs, no mail, no
# Claude, no Telegram) on a copy of the database, opens the main pages as a guest and as the owner, and fails
# when one does not answer as expected, comes back without the end of its page, or the server logs an error.
# web.yml runs it before every deploy, so a broken page stops the deploy instead of reaching readers.
#
# The database: the nightly scrubbed test copy (scripts/fetch-test-db.sh, which finds the age key in
# $CHYTAI_BACKUP_KEY, a key file's path), else ./data/web/chytai.db if there is one, else a fresh empty
# one (the seed only), which still catches a server that does not start or a page that throws.
# The reader (server/) has its own: scripts/smoke-reader.sh.
# Usage: scripts/smoke-test.sh            (from the repo root, after npm ci)
set -u
cd "$(dirname "$0")/.."
PORT=${SMOKE_PORT:-8099}
BASE="http://localhost:$PORT"
DIR=$(mktemp -d)
LOG="$DIR/server.log"
JAR="$DIR/cookies"
fail=0

export CHYTAI_TEST_COVERS=0 # the pages are checked, not their pictures
if command -v age >/dev/null; then scripts/fetch-test-db.sh "$DIR/data" >/dev/null 2>&1 || echo "smoke: no test copy ($(scripts/fetch-test-db.sh "$DIR/data" 2>&1 | tail -1))"; fi
mkdir -p "$DIR/data/web"
if [ -s data/web/chytai.db ] && [ ! -s "$DIR/data/web/chytai.db" ]; then cp data/web/chytai.db "$DIR/data/web/"; fi
real=0
[ -s "$DIR/data/web/chytai.db" ] && real=1
echo "smoke: $([ $real = 1 ] && echo "test copy of the database" || echo "empty database")"

CHYTAI_ROLE=web PORT=$PORT DATA_DIR="$DIR/data" node web/server.js >"$LOG" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$DIR"' EXIT
for _ in $(seq 1 120); do
  curl -s -o /dev/null "$BASE/robots.txt" && break
  kill -0 $pid 2>/dev/null || break
  sleep 0.5
done
if ! curl -s -o /dev/null "$BASE/robots.txt"; then
  echo "smoke: the server did not start"; cat "$LOG"; exit 1
fi

# check <path> <expected status> [cookie jar]: the status, and for a 200 page the end of its HTML.
check() {
  local path=$1 want=$2 jar=${3:-} code
  code=$(curl -s -o "$DIR/page" -w "%{http_code}" -m 20 ${jar:+-b "$jar"} "$BASE$path" || echo 000)
  if [ "$code" != "$want" ]; then
    echo "FAIL $path: HTTP $code, expected $want: $(head -c 300 "$DIR/page" | tr '\n' ' ')"; fail=1
  elif [ "$code" = 200 ] && [[ "$path" != *.xml && "$path" != *.txt ]] && ! grep -qi "</html>" "$DIR/page"; then
    echo "FAIL $path: the page stops before </html>"; fail=1
  else
    echo "ok   $path $code"
  fi
}

# As a guest.
check / 200
check /community 200
check /publishers 200
check /updates 200
check /lists 200
check /club 200
check /articles 404
check /login 200
check /ask/0000000000 404 # «Що почитати далі» (ask.js): the field is behind the flag `ask`, an unknown answer is 404
check /privacy 200
check "/search?q=%D0%BB%D0%B5%D0%BC" 200
check /sitemap.xml 200
check /robots.txt 200
check /book/no-such-book-smoke 404
check /me 302
check /admin 403
if [ $real = 1 ]; then
  check /publishers/starylev 200
  check /@maxua 200
  check /book/east-of-eden 200
  check /genre/fentezi 200
  check /author/serhii-zhadan 200
fi

# As the owner (the test copy has owner@test.invalid; without RESEND_API_KEY the code is in the log).
if [ $real = 1 ]; then
  curl -s -c "$JAR" -o /dev/null -d "email=owner@test.invalid" "$BASE/login"
  code=$(grep -o "входу на [^:]*: [0-9]\{6\}" "$LOG" | tail -1 | grep -o "[0-9]\{6\}$")
  curl -s -c "$JAR" -b "$JAR" -o /dev/null -d "email=owner@test.invalid&code=$code" "$BASE/login/code"
  if grep -q chytai "$JAR" 2>/dev/null; then
    for p in /@maxua /settings /add /admin /admin/traffic /admin/readers /admin/retention /admin/reader /admin/comments /admin/digest /admin/catalog /admin/jobs /admin/speed /admin/activity; do
      check "$p" 200 "$JAR"
    done
  else
    echo "FAIL: could not sign in as the owner"; fail=1
  fi
fi

# Errors the server wrote down meanwhile (a page that threw is caught by express and logged).
if grep -nE "^(TypeError|ReferenceError|SyntaxError|RangeError)|Error: |    at " "$LOG" | grep -v "is not set" | head -20 | grep .; then
  echo "FAIL: errors in the server log"; fail=1
fi
kill -0 $pid 2>/dev/null || { echo "FAIL: the server died"; tail -30 "$LOG"; fail=1; }
[ $fail = 0 ] && echo "smoke: all fine" || { echo "--- server log ---"; tail -40 "$LOG"; }
exit $fail
