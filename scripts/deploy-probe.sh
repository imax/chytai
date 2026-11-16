#!/usr/bin/env bash
# The deploy probe (Max, 2026-11-16: a log to see whether deploys really stop taking the site down). web.yml starts
# it before flyctl and stops it after the post-release check: meanwhile it asks /robots.txt every second, as a
# visitor would (a static file, through the site's Node process). Then it tells the site (/agent/deploys, deploys.js):
# down_ms = the longest stretch with no answer within 5 s, fails = probes with none, fly_errors = requests Fly's proxy
# could not deliver over that time (Prometheus, only if the token may read it).
#   scripts/deploy-probe.sh start            (in the background until stop)
#   scripts/deploy-probe.sh stop <sha> [hot]
# Env: SITE_TOKEN (a Fly token that sees chytai-web), FLY_API_TOKEN (Prometheus, optional), SITE.
set -u
SITE=${SITE:-https://chytai.org.ua}
DIR=${RUNNER_TEMP:-/tmp}/deploy-probe
case "${1:-}" in
  start)
    mkdir -p "$DIR" && : > "$DIR/log" && date -u +%FT%T.000Z > "$DIR/since"
    (while [ ! -f "$DIR/stop" ]; do
      t=$(date +%s.%N)
      c=$(curl -s -o /dev/null -m 5 -A "chytai-deploy-probe" -w '%{http_code}' "$SITE/robots.txt?probe=$RANDOM" || true)
      echo "$t ${c:-000}" >> "$DIR/log"
      sleep 1
    done) > /dev/null 2>&1 &
    echo "probing $SITE every second"
    ;;
  stop)
    SHA=${2:-} KIND=${3:-probe}
    touch "$DIR/stop"; sleep 2
    since=$(cat "$DIR/since" 2>/dev/null || date -u +%FT%T.000Z)
    # The longest stretch without a 200: from the last good probe before it to the first good one after.
    read -r down fails total < <(awk '
      { ok = ($2 == "200"); n++
        if (!ok) { f++; if (!inbad) { inbad = 1; start = (last ? last : $1) } }
        else { if (inbad) { d = $1 - start; if (d > m) m = d; inbad = 0 } last = $1 } }
      END { if (inbad) { d = $1 - start; if (d > m) m = d } printf "%d %d %d\n", m * 1000, f, n }' "$DIR/log")
    secs=$(( $(date +%s) - $(date -d "$since" +%s) + 60 ))
    fly=""
    if [ -n "${FLY_API_TOKEN:-}" ]; then
      fly=$(curl -s -m 20 -G "https://api.fly.io/prometheus/personal/api/v1/query" -H "Authorization: $FLY_API_TOKEN" \
        --data-urlencode "query=sum(increase(fly_edge_error_count{app=\"chytai-web\"}[${secs}s]))" | jq -r 'if .status == "success" then (.data.result[0].value[1] // "0") else empty end' 2>/dev/null | cut -d. -f1)
    fi
    echo "probes: $total, no answer: $fails, longest pause: ${down} ms, Fly could not deliver: ${fly:-unknown}"
    body=$(jq -n --arg at "$since" --arg sha "$SHA" --arg kind "$KIND" --argjson down "${down:-0}" --argjson fails "${fails:-0}" --arg fly "$fly" --arg note "$total probes" \
      '{at: $at, sha: $sha, kind: $kind, down_ms: $down, fails: $fails, fly_errors: (if $fly == "" then null else ($fly | tonumber) end), note: $note}')
    curl -s -m 20 "$SITE/agent/deploys" -H "Authorization: $SITE_TOKEN" -H 'content-type: application/json' -d "$body" || echo "::warning::could not report the probe"
    echo
    ;;
  *) echo "usage: $0 start | stop <sha> [hot]" >&2; exit 2 ;;
esac
