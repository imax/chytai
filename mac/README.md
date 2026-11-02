# Chytai для Mac

Вікно над вебчиталкою https://app.chytai.org.ua: той самий акаунт, книжки, нотатки й дизайн, що на телефоні.
Кожен деплой Читалки доходить сюди сам; нова збірка потрібна лише тоді, коли міняється сам `main.js`.

Старий локальний застосунок (папки з книжками і свій ключ Anthropic) лишається в `src/main.js`.

## Зібрати DMG (лише на Mac)

```
cd mac
npm install
npm run dist          # dist/Chytai-1.0.0.dmg, universal (Apple Silicon і Intel)
```

Підпис і нотаризація потрібні, щоб DMG із сайту відкривався без попереджень:

- у Keychain має бути сертифікат «Developer ID Application» (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application);
- нотаризація вмикається сама, якщо перед `npm run dist` задати `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com → Паролі для застосунків) і `APPLE_TEAM_ID`.

Без них збірка теж вийде, але macOS попередить, що розробника не перевірено.
