#!/usr/bin/env bash
# A deploy without restarting the machine (web/release.js, Max 2026-11-16): the site's files of commit <sha> go to the
# volume, and main.js moves the site to them once a fresh web process has opened a few pages. web.yml runs it first;
# rollout-watch.sh and web.yml's rollback run it with the commit before.
#   scripts/hot-deploy.sh <sha>
# Prints the machine's answer and writes result=ok|full|failed to $GITHUB_OUTPUT:
#   ok     the site runs <sha>, nothing restarted;
#   full   this needs an image deploy (web/package*.json, main.js or the Dockerfile changed, no ssh, an older image): nothing
#          changed on the site, web.yml deploys an image as before;
#   failed the new code did not open its pages: the old code goes on answering, the run fails.
# Env: FLY_API_TOKEN (the deploy token of chytai-web).
set -u
sha=$1
out=${GITHUB_OUTPUT:-/dev/stdout}
answer() { echo "result=$1" >> "$out"; echo "hot deploy: $1"; exit 0; }
FILES="web server/agent.js server/aimeter.js build/icon.png"
if git cat-file -e "$sha^{commit}" 2>/dev/null; then
  tgz=${RUNNER_TEMP:-/tmp}/site-$sha.tgz
  git archive --format=tar.gz -o "$tgz" "$sha" $FILES || answer full
  echo "uploading $(du -h "$tgz" | cut -f1)"
  timeout 120 flyctl ssh sftp put -a chytai-web "$tgz" "/data/web/releases/incoming/$sha.tgz" || { echo "::warning::upload failed"; answer full; }
fi
said=$(timeout 300 flyctl ssh console -a chytai-web -C "node /app/web/hotdeploy.js $sha" 2>&1)
echo "$said"
kind=$(echo "$said" | grep -o "HOT: [a-z]*" | tail -1 | cut -d' ' -f2)
case "$kind" in
  ok) answer ok ;;
  failed) answer failed ;;
  *) answer full ;;
esac
