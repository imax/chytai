#!/usr/bin/env bash
# One-off move of the web reader from the Fly app ai-reader-max to a new app chytai
# (https://chytai.fly.dev), with all books and everyone's reading positions.
# Run from the project folder on the Mac:  bash scripts/move-to-chytai.sh
# The old app keeps running untouched; remove it later with: fly apps destroy ai-reader-max
set -euo pipefail

OLD=ai-reader-max
NEW=chytai
REGION=fra
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E "s/^(['\"])(.*)\1$/\2/"; }
for k in ANTHROPIC_API_KEY READER_PASSWORD READER_SECRET; do
  [ -n "$(env_value $k)" ] || { echo "У .env немає $k"; exit 1; }
done

echo "== 1/5 Створюю застосунок $NEW і диск для книжок"
# Safe to re-run: skips what already exists.
fly status -a "$NEW" >/dev/null 2>&1 || fly apps create "$NEW"
fly volumes list -a "$NEW" 2>/dev/null | grep -q reader_data || fly volumes create reader_data -a "$NEW" -r "$REGION" -s 3 -y

echo "== 2/5 Секрети"
fly secrets set -a "$NEW" --stage \
  ANTHROPIC_API_KEY="$(env_value ANTHROPIC_API_KEY)" \
  READER_PASSWORD="$(env_value READER_PASSWORD)" \
  READER_SECRET="$(env_value READER_SECRET)"

echo "== 3/5 Деплой"
fly deploy -a "$NEW"

echo "== 4/5 Копіюю книжки й позиції зі старого застосунку"
curl -fsS -o /dev/null "https://$OLD.fly.dev/login" || true # wakes the stopped machine
sleep 5
fly ssh console -a "$OLD" -C "tar czf /tmp/data.tgz -C /data ."
rm -f ./chytai-data.tgz
fly ssh sftp get -a "$OLD" /tmp/data.tgz ./chytai-data.tgz
curl -fsS -o /dev/null "https://$NEW.fly.dev/login" || true
sleep 5
fly ssh sftp put -a "$NEW" ./chytai-data.tgz /tmp/data.tgz 2>/dev/null \
  || printf 'put ./chytai-data.tgz /tmp/data.tgz\n' | fly ssh sftp shell -a "$NEW"
fly ssh console -a "$NEW" -C "ls -l /tmp/data.tgz"
fly ssh console -a "$NEW" -C "tar xzf /tmp/data.tgz -C /data"

echo "== 5/5 Перезапуск, щоб сервер підхопив позиції"
fly apps restart "$NEW"
sleep 5
curl -fsS -o /dev/null -w "https://$NEW.fly.dev/login → %{http_code}\n" "https://$NEW.fly.dev/login"
echo "Готово. Резервна копія даних лишилася тут: ./chytai-data.tgz"
