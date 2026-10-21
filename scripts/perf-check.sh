#!/usr/bin/env bash
# The post-release check of https://chytai.org.ua (Max, 2026-10-21, after a release pegged the CPU and the
# site lay down for an hour): times a fixed set of the main pages, each asked three times with the
# fastest answer counting (one network hiccup does not trip it), and fails when one does not answer
# or takes longer than the limit. web.yml runs it after every deploy and rolls back when it fails.
# Usage: scripts/perf-check.sh [limit in seconds, default 1.5]
set -u
LIMIT=${1:-1.5}
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
  /author/john-steinbeck
  /updates
)
slow=()
for p in "${pages[@]}"; do
  best=99
  for _ in 1 2 3; do
    r=$(curl -s -o /dev/null -m 30 -w "%{http_code} %{time_total}" "$SITE$p" || echo "000 99")
    code=${r%% *} t=${r##* }
    [ "$code" = 200 ] && awk "BEGIN{exit !($t < $best)}" && best=$t
  done
  printf "%-32s %6.2f s\n" "$p" "$best"
  awk "BEGIN{exit !($best > $LIMIT)}" && slow+=("$p (${best} s)")
done
if [ ${#slow[@]} -gt 0 ]; then
  msg="Slower than ${LIMIT} s or not answering: ${slow[*]}"
  echo "$msg"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$msg" >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi
echo "All pages under ${LIMIT} s"
