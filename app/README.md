# Chytai для iPhone

Нативна оболонка (Expo, React Native) навколо веб-читалки з https://chytai.fly.dev. Сама читалка лишається веб-кодом із `src/renderer/`, тож усе, що мержиться в main, доїжджає в застосунок через звичайний деплой на Fly. Оболонка додає іконку й повний екран без Safari, збережений вхід і (далі) share sheet для EPUB.

## Як оновлюється

| Що змінилося | Як доїжджає | Ревʼю Apple |
| --- | --- | --- |
| Сервер або читалка (`server/`, `src/`) | `deploy.yml` → Fly, як і раніше | ні |
| Код оболонки (`app/App.js` тощо) | `app-update.yml` → EAS Update, застосунок підхоплює при наступному запуску | ні |
| Нативна частина (нові Expo-модулі, дозволи в `app.json`, нова версія SDK) | `app-build.yml` вручну → EAS Build → TestFlight | внутрішні тестери: ні |

Білд у TestFlight живе 90 днів, потім запускається `app-build.yml` ще раз.

## Як це налаштовано (зроблено 2026-10-14)

- Проєкт Expo `@maxua/chytai` (projectId в `app.json`), Apple Team `QFMJ75865U` (акаунт компанії, enrolled as Organization), застосунок в App Store Connect з Apple ID `6822684944`.
- Логін в Apple ID паролем через EAS не працював, тому все йде через ключ App Store Connect API (Key ID і Issuer ID у `eas.json`, сам файл `AuthKey_*.p8` лежить у `app/` на Mac і в `.gitignore`). Для `eas build` з Mac його передають змінні `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`; для `eas submit` шлях уже вписаний у `eas.json`.
- Сертифікат і provisioning profile створені EAS і зберігаються на Expo.
- Секрети репозиторію для CI: `EXPO_TOKEN` (https://expo.dev/settings/access-tokens) і `ASC_API_KEY_P8` (вміст файлу .p8).

Ручний білд з Mac:

```
cd app
export EXPO_ASC_API_KEY_PATH=./AuthKey_8JWQG97Z96.p8 EXPO_ASC_KEY_ID=8JWQG97Z96 EXPO_ASC_ISSUER_ID=d9a2c344-6f99-434e-bc3e-ac56381bd61d
eas build --platform ios --profile production
eas submit --platform ios --latest
```

## Локально

```
cd app && npm install && npx expo start
```

У Expo Go застосунок відкривається, але WebView там працює з обмеженнями; повноцінно перевіряти варто в development build або в TestFlight.
