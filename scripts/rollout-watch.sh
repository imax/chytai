#!/usr/bin/env bash
# The rollout watch (Max, 2026-11-09, from Amp's talk: «ship it, then check in a while whether errors went up»):
# some minutes after a deploy, asks the site for errors recorded since the deploy that it had not seen in the week
# before. A new error seen at least twice: the previous image goes back, Max gets a line in Telegram, and the run
# fails (the commit stays on main to be fixed). A newer deploy since then: nothing to do (its own watch runs).
# web.yml and deploy.yml run it as a separate job after the deploy, so it holds up no deploy.
#
# Usage: scripts/rollout-watch.sh <app: chytai-web | chytai> <deploy start, ISO> <image before, may be empty>
# Env: SHA (the commit deployed), SITE_TOKEN (a Fly token that sees chytai-web: the site's /agent/* endpoints),
#      FLY_API_TOKEN (deploy token of <app>, for the rollback), WAIT (seconds, default 900), DRY=1 (only look).
set -u
APP=$1 SINCE=$2 BEFORE=${3:-}
SITE=${SITE:-https://chytai.org.ua}
if [ "$APP" = chytai-web ]; then PLACES="'site','jobs'"; HEALTH=$SITE/agent/health; HTOKEN=$SITE_TOKEN; CONFIG="-c web/fly.toml"; NAME="Сайт"
else PLACES="'reader'"; HEALTH=https://app.chytai.org.ua/agent/health; HTOKEN=$FLY_API_TOKEN; CONFIG=""; NAME="Читалка"; fi

sleep "${WAIT:-900}"

live=$(curl -s -m 30 "$HEALTH" -H "Authorization: $HTOKEN" | jq -r '.commit // empty')
echo "live commit: ${live:-unknown}, deployed: $SHA"
if [ -z "$live" ]; then echo "::warning::could not read $HEALTH; no check"; exit 0; fi
if [ "$live" != "$SHA" ]; then echo "a newer deploy (or a rollback) is live; its own watch checks it"; exit 0; fi

WEEK=$(date -u -d "$SINCE - 7 days" +%FT%T.000Z)
Q="SELECT place, msg, COUNT(*) AS n, MAX(url) AS url FROM errors WHERE at >= '$SINCE' AND place IN ($PLACES) AND msg NOT IN (SELECT msg FROM errors WHERE at < '$SINCE' AND at >= '$WEEK') GROUP BY place, msg ORDER BY n DESC"
ans=$(curl -s -m 30 "$SITE/agent/sql" -H "Authorization: $SITE_TOKEN" -H 'content-type: application/json' -d "$(jq -n --arg q "$Q" '{q: $q}')")
if ! echo "$ans" | jq -e '.rows' >/dev/null 2>&1; then echo "::warning::errors query failed: $ans"; exit 0; fi
echo "new errors since $SINCE:"; echo "$ans" | jq -r '.rows[] | "  \(.n)× [\(.place)] \(.msg) \(.url)"'
bad=$(echo "$ans" | jq '[.rows[] | select(.n >= 2)] | length')
[ "$bad" = 0 ] && { echo "no new error seen twice: the rollout is fine"; exit 0; }
[ -n "${DRY:-}" ] && { echo "DRY: would roll back and tell Max"; exit 1; }

text="$NAME: після деплою ${SHA:0:7} нові помилки:
$(echo "$ans" | jq -r '.rows[:3][] | "\(.n)× \(.msg | .[0:150])"')"
if [ -n "$BEFORE" ]; then
  echo "rolling back to $BEFORE"
  if flyctl deploy -a "$APP" $CONFIG --image "$BEFORE"; then text="$text

Відкотив до попередньої версії. Коміт лишився в main, треба полагодити."
  else text="$text

Відкотити не вдалося, глянь Actions."; fi
else text="$text

Попередньої версії не знайшов, не відкочував."; fi
curl -s -m 30 "$SITE/agent/notify" -H "Authorization: $SITE_TOKEN" -H 'content-type: application/json' -d "$(jq -n --arg t "$text" '{text: $t}')" || true
echo
exit 1
