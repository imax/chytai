#!/usr/bin/env bash
# Smoke test of the reader (app.chytai.org.ua, server/index.js) before it deploys (Max, 2026-11-04): every file
# the Dockerfile copies is in the repo (2026-11-04 a deploy failed on a landing picture that was never
# committed), the server starts on an empty data folder, and its main addresses answer as expected.
# deploy.yml runs it before every deploy. Usage: scripts/smoke-reader.sh (from the repo root, after npm ci)
set -u
cd "$(dirname "$0")/.."
PORT=${SMOKE_PORT:-8098}
BASE="http://localhost:$PORT"
DIR=$(mktemp -d)
LOG="$DIR/server.log"
fail=0

# The Dockerfile's COPY sources (not the --from= ones).
for f in $(grep -E '^COPY ' Dockerfile | grep -v -- '--from' | sed -E 's/^COPY +//; s/ +[^ ]+$//'); do
  [ -e "$f" ] || { echo "FAIL Dockerfile copies $f, which is not in the repo"; fail=1; }
done

READER_SECRET=smoke PORT=$PORT DATA_DIR="$DIR/data" node server/index.js >"$LOG" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$DIR"' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null "$BASE/login" && break
  kill -0 $pid 2>/dev/null || break
  sleep 0.5
done
if ! curl -s -o /dev/null "$BASE/login"; then
  echo "smoke: the reader did not start"; cat "$LOG"; exit 1
fi

check() {
  local path=$1 want=$2 code
  code=$(curl -s -o "$DIR/page" -w "%{http_code}" -m 20 "$BASE$path" || echo 000)
  if [ "$code" != "$want" ]; then echo "FAIL $path: HTTP $code, expected $want: $(head -c 300 "$DIR/page" | tr '\n' ' ')"; fail=1
  else echo "ok   $path $code"; fi
}
check / 200
check /login 200
check /sw.js 200
check /api/library 401

if grep -nE "^(TypeError|ReferenceError|SyntaxError|RangeError)|Error: |    at " "$LOG" | head -20 | grep .; then
  echo "FAIL: errors in the server log"; fail=1
fi
kill -0 $pid 2>/dev/null || { echo "FAIL: the reader died"; tail -30 "$LOG"; fail=1; }
[ $fail = 0 ] && echo "smoke: all fine" || { echo "--- server log ---"; tail -40 "$LOG"; }
exit $fail
