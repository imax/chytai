# Chytai для Mac

Вікно над вебчиталкою https://app.chytai.org.ua: той самий акаунт, книжки, нотатки й дизайн, що на телефоні.
Кожен деплой Читалки доходить сюди сам; нова збірка потрібна лише тоді, коли міняється `Chytai.swift`.

З 2.0 (2026-11-10) це Swift із WKWebView (рушій Safari), без Electron: DMG важить кілька сотень КБ замість ~200 МБ.
Один файл `Chytai.swift`, `Info.plist`, `icon.png`, збирає `build.sh`. Старий локальний застосунок (папки з книжками
і свій ключ Anthropic) лишається в `src/main.js`.

## Запустити й зібрати (лише на Mac)

```
mac/build.sh                                  # build/Chytai.app і build/Chytai.dmg (Apple Silicon і Intel)
open mac/build/Chytai.app
CHYTAI_URL=http://localhost:8080 mac/build/Chytai.app/Contents/MacOS/Chytai   # над локальною Читалкою
```

Потрібні лише інструменти командного рядка Xcode (`xcode-select --install`). Інспектор сторінки: правий клік →
Inspect Element (Safari → Settings → Advanced → «Show features for web developers»).

## Вхід через Google

Google не пускає вхід у вбудованому вікні, тож кнопка відкриває вхід сайту в браузері з
`next=/reader-login?back=<читалка>&to=mac`. Сайт тоді показує «Повертаємось у Chytai» і відкриває
`chytai://auth?ticket=…`; аппка (схема `chytai` в `Info.plist`) несе квиток на `/auth` Читалки. Кнопку на сторінці
входу Читалка показує лише `ChytaiMac/2` і новішим.

## Випуск

`.github/workflows/mac.yml` на кожен пуш у `mac/`: збирає, раз відкриває Читалку (`-selftest YES`: сторінка
завантажилась, service worker працює), і на `main` викладає реліз `mac-v<версія>`, якщо версія в `Info.plist`
нова. https://chytai.org.ua/mac завжди веде на найновіший. Гілка `claude/**` дає пре-реліз `mac-beta`, щоб
спробувати до випуску.

Поки без підпису (Max, 2026-11-02: зробить особистий акаунт Apple Developer): ad-hoc підпис, і людина один раз
дозволяє відкрити застосунок у Системних параметрах. Коли буде сертифікат «Developer ID Application»: у `build.sh`
`codesign --sign "Developer ID Application: …" --options runtime` (з entitlements камери й мікрофона), потім
`xcrun notarytool submit build/Chytai.dmg --key … --wait` і `xcrun stapler staple`.
