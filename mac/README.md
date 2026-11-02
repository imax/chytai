# Chytai для Mac

Вікно над вебчиталкою https://app.chytai.org.ua: той самий акаунт, книжки, нотатки й дизайн, що на телефоні.
Кожен деплой Читалки доходить сюди сам; нова збірка потрібна лише тоді, коли міняється сам `main.js`.

Старий локальний застосунок (папки з книжками і свій ключ Anthropic) лишається в `src/main.js`.

## Зібрати DMG (лише на Mac)

```
cd mac
npm install
npm run dist          # dist/Chytai.dmg, universal (Apple Silicon і Intel)
```

Підпис і нотаризація потрібні, щоб DMG із сайту відкривався без попереджень:

- у Keychain має бути сертифікат «Developer ID Application» (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application);
- нотаризація вмикається сама, якщо перед `npm run dist` задати ключ App Store Connect, той самий, що для iPhone-аппки:
  `APPLE_API_KEY=$PWD/../app/AuthKey_8JWQG97Z96.p8 APPLE_API_KEY_ID=8JWQG97Z96 APPLE_API_ISSUER=d9a2c344-6f99-434e-bc3e-ac56381bd61d npm run dist`
  (або `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

Поки без підпису (Max, 2026-11-02: зробить особистий акаунт Apple Developer): `mac.identity` = "-" дає ad-hoc підпис, і людина один раз дозволяє відкрити застосунок у Системних параметрах. Коли буде сертифікат, прибрати `identity` з package.json.
Збирає DMG і викладає реліз `mac-v<версія>` workflow `.github/workflows/mac.yml` на кожен пуш у mac/, якщо версія нова.
Готовий `dist/Chytai.dmg` іде в GitHub Release, а https://chytai.org.ua/mac завжди веде на найновіший.

Без них збірка теж вийде, але macOS попередить, що розробника не перевірено.
