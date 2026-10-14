# Chytai для iPhone

Нативна оболонка (Expo, React Native) навколо веб-читалки з https://chytai.fly.dev. Сама читалка лишається веб-кодом із `src/renderer/`, тож усе, що мержиться в main, доїжджає в застосунок через звичайний деплой на Fly. Оболонка додає іконку й повний екран без Safari, збережений вхід і (далі) share sheet для EPUB.

## Як оновлюється

| Що змінилося | Як доїжджає | Ревʼю Apple |
| --- | --- | --- |
| Сервер або читалка (`server/`, `src/`) | `deploy.yml` → Fly, як і раніше | ні |
| Код оболонки (`app/App.js` тощо) | `app-update.yml` → EAS Update, застосунок підхоплює при наступному запуску | ні |
| Нативна частина (нові Expo-модулі, дозволи в `app.json`, нова версія SDK) | `app-build.yml` вручну → EAS Build → TestFlight | внутрішні тестери: ні |

Білд у TestFlight живе 90 днів, потім запускається `app-build.yml` ще раз.

## Перший запуск (разово, на Mac Макса)

1. `npm i -g eas-cli`, `cd app`, `eas login` (акаунт Expo, безкоштовний).
2. `eas init` записує `extra.eas.projectId` в `app.json`; `eas update:configure` додає `updates.url`. Закомітити.
3. `eas build --platform ios --profile production` — EAS сам створює App ID і сертифікати після входу в Apple Developer (ischenko@gmail.com). Після цього білд і сабміт з CI працюють без інтерактиву.
4. У App Store Connect створити застосунок Chytai (один раз), потім `eas submit --platform ios --latest` або `--auto-submit` під час білду. Внутрішнім тестерам (до 100 людей з акаунта) білд видно в TestFlight без ревʼю.
5. Токен для CI: https://expo.dev/settings/access-tokens → секрет репозиторію `EXPO_TOKEN`.

## Локально

```
cd app && npm install && npx expo start
```

У Expo Go застосунок відкривається, але WebView там працює з обмеженнями; повноцінно перевіряти варто в development build або в TestFlight.
