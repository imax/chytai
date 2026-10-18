# Chytai web: бібліотека, Discovery, рекомендації

Платформена частина Chytai, окремо від читалки (`server/`): сторінки «Мої книжки», Discovery з публічними
полицями і «Що почитати». Node + Express, HTML рендериться на сервері, дані в JSON.

- `server.js` маршрути; `store.js` дані; `pages.js` HTML; `recommend.js` поради від Claude; `public/` CSS і JS.
- `seed/books.json`, `seed/max.json`: одноразовий імпорт Books.md і books-meta.yml з maxua-v3
  (`node web/scripts/import-books.mjs ../maxua-v3`). Далі бібліотека живе у `DATA_DIR/web/library.json`.
- `seed/office.json`: паперові книжки в офісі (з фото, 18.10.2026); російськомовні в профіль не додаються.
- `catalogs/*.json` сирі каталоги джерел; `node web/scripts/build-shelves.mjs` збирає з них `seed/shelves.json`.
  Джерела: Lobster і Видавництво (WooCommerce Store API), Standard Ebooks (Atom-стрічка нових випусків).
- Твір і видання: однакові книжки на полицях (той самий ISBN або автор+назва) і в бібліотеці (точний збіг назви
  чи оригінальної назви) склеюються в одну; `seed/matches.json` для пар, які збіг назв пропускає або плутає.
  Полиця показує одну картку на твір, сторінка книжки всі видання з кнопками, записи в бібліотеці йдуть на твір.

Запуск: `WEB_LOGIN_TOKEN=… npm run platform`, далі відкрити `/login/<token>` раз, і браузер залогінений.
Деплой: окремий Fly-застосунок `chytai-web` (`web/fly.toml`, `web/Dockerfile`, workflow `.github/workflows/web.yml`).
