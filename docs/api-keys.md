# Ключ Anthropic API: де він живе

Усі місця, які треба оновити, якщо міняєш `ANTHROPIC_API_KEY`. Значень тут немає й не має бути (репо публічне).

1. **Сайт** (Fly app `chytai-web`, web/server.js: «Чи варто читати?», огляди книжок, жанри, пошук українських видань, AI-проходи по каталогу):
   `fly secrets set ANTHROPIC_API_KEY=sk-ant-… -a chytai-web`
2. **Читалка** (Fly app `chytai`, server/index.js: Пояснити / Запитати, перевірка завантажених файлів у server/content.js):
   `fly secrets set ANTHROPIC_API_KEY=sk-ant-… -a chytai`
3. **Локально на Mac**: `~/Projects/chytai/.env`, рядок `ANTHROPIC_API_KEY=…`. Його читають десктопна читалка (Electron) і web/scripts/advice-sample.mjs. Потрібно лише для локального запуску.
4. **Десктопна читалка, налаштування (⌘,)**: якщо ключ колись вставляли там, він зберігається зашифрованим у Keychain і має пріоритет над `.env`. Вставити новий або очистити поле.

Після цього відкликати старий ключ на https://platform.claude.com → API Keys.

Ключа Anthropic **немає** в GitHub Actions secrets (там лише FLY_API_TOKEN, FLY_API_TOKEN_WEB, EXPO_TOKEN, ASC_API_KEY_P8) і в iOS-застосунку (app/ — лише WebView).

`fly secrets set` сам перезапускає машини застосунку, окремий деплой не потрібен. family-ea не чіпати.
