#!/usr/bin/env bash
# The post-release check of https://chytai.org.ua (Max, 2026-10-21, after a release pegged the CPU and the
# site lay down for an hour): times a fixed set of the main pages, each asked three times with the
# fastest answer counting (one network hiccup does not trip it), and fails when one does not answer
# or takes longer than the limit. web.yml runs it after every deploy and rolls back when it fails.
# The server's own share (its Server-Timing header, network aside) has a tighter limit of its own: a page
# that got heavier shows here first (Max, 2026-10-25, after the site got fast: «важливо це не втратити»).
# Usage: scripts/perf-check.sh [limit in seconds, default 1.5] [server limit in seconds, default 0.8]
set -u
LIMIT=${1:-1.5}
APP_LIMIT=${2:-0.8}
SITE=${SITE:-https://chytai.org.ua}
pages=(
  /                                   # home: recommendations, feed
  /community                          # every reader's shelf (2.2 s before 3571e6f)
  /publishers
  /publishers/starylev                # the biggest shelf
  "/search?q=%D0%BB%D0%B5%D0%BC"      # «лем»
  /@maxua                             # the biggest reader's shelf
  /book/east-of-eden                  # a book with editions and readers
  /book/tsyrtseia
  /updates
  /popular
  /genre/fentezi                      # the biggest genre
  /author/serhii-zhadan               # an author with many books and readers
)
# The fastest of three answers: "<seconds> <server seconds>" (99 when none came); a redirect is followed
# (a renamed slug is not a breakage). A page that does not answer 200 has its status and the start of its
# body printed.
measure() {
  local best=99 app=99 r code t a
  for _ in 1 2 3; do
    r=$(curl -sL -o /tmp/perf-page -D /tmp/perf-head -m 30 -w "%{http_code} %{time_total}" "$SITE$1" || echo "000 99")
    code=${r%% *} t=${r##* }
    a=$(grep -i '^server-timing:' /tmp/perf-head 2>/dev/null | tail -1 | sed -E 's/.*dur=([0-9.]+).*/\1/' | tr -d '\r')
    a=$(awk "BEGIN{print ${a:-99000}/1000}")
    if [ "$code" = 200 ]; then
      awk "BEGIN{exit !($t < $best)}" && best=$t
      awk "BEGIN{exit !($a < $app)}" && app=$a
    else echo "  $1: HTTP $code: $(head -c 300 /tmp/perf-page 2>/dev/null | tr '\n' ' ')" >&2; fi
  done
  echo "$best $app"
}
# Over either limit.
over() { awk "BEGIN{exit !(${1% *} > $LIMIT || ${1#* } > $APP_LIMIT)}"; }
# An author's address follows the spelling most of their books use, so it can change with the data
# (Стейнбек's moved on 2026-10-22): the author page is the one linked from a book page.
author=$(curl -s -m 30 "$SITE/book/east-of-eden" | grep -o 'href="/author/[^"]*"' | head -1 | cut -d'"' -f2)
pages+=("${author:-/author/missing-on-book-page}")
slow=()
for p in "${pages[@]}"; do
  m=$(measure "$p")
  printf "%-32s %6.2f s, server %5.2f s\n" "$p" ${m% *} ${m#* }
  over "$m" && slow+=("$p")
done
# Right after a start the server warms up (a heavy shelf took 1.7 s once and 0.6 s a minute later,
# 2026-10-21), so a slow page is asked again after half a minute before it counts.
if [ ${#slow[@]} -gt 0 ]; then
  echo "slow: ${slow[*]}; again in 30 s"
  sleep 30
  still=()
  for p in "${slow[@]}"; do
    m=$(measure "$p")
    printf "%-32s %6.2f s, server %5.2f s (again)\n" "$p" ${m% *} ${m#* }
    over "$m" && still+=("$p (${m% *} s, server ${m#* } s)")
  done
  if [ ${#still[@]} -gt 0 ]; then
    msg="Slower than ${LIMIT} s (server ${APP_LIMIT} s) or not answering: ${still[*]}"
    echo "$msg"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$msg" >> "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
fi
echo "All pages under ${LIMIT} s, server under ${APP_LIMIT} s"
