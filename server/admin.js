// What Claude costs, for the reader's stats (index.js collectStats), shown on the owner's «Адмінка» in the reader.

// $ per million tokens: [input, output, cache read, cache write]. Rough, for a sense of scale only.
const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5-5-fast": [8, 40, 0.4, 10], // fast mode: twice the price (ai.js "-fast")
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES).find((k) => model.startsWith(k));
  return base ? PRICES[base] : null;
}

// Cost in USD of one { input, output, cacheRead, cacheWrite } token record; null when the model is unknown.
function cost(model, t) {
  const p = priceFor(model);
  if (!p) return null;
  return (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite * p[3]) / 1e6;
}

// Names of the reader's controls and its features (Max 2026-11-20: moved here from web/admin.js, so the reader's own
// «Адмінка» and the site's /admin/reader read one list; collectStats sends both).
// The reader's controls by their id or data-action (reading-time.js count), for «Що натискають» on the owner's «Адмінка» (home.js, admin-view.js) and the site's /admin/reader.
const UI_NAMES = { "btn-library": "Мої книжки", "m-back": "Мої книжки (телефон)", "btn-toc": "Зміст", "btn-notes": "Нотатки", "btn-settings": "Налаштування", mlook: "Аа (вигляд)", "btn-font-down": "Менший шрифт", "btn-font-up": "Більший шрифт", "btn-panel": "Панель пояснень", "btn-search": "Пошук у книжці", "m-search": "Пошук у книжці (телефон)", "btn-print": "Друкувати", "btn-back": "Назад після посилання", "sel-explain": "Пояснити / Запитати", "sel-translate": "Перекласти", "sel-note": "Зберегти", "sel-mark-note": "Позначити", "sel-mic": "Голосом", "sel-open": "Відкрити пояснення", "ask-open": "Пояснення під абзацом: розгорнути", "ask-close": "Пояснення під абзацом: згорнути", gloss: "Словничок: слово", "gloss-ahead": "Підкреслене слово, підготовлене наперед", "act-gloss-know": "Словничок: «Знаю це слово»", word: "Одне слово: значення одразу", "word-ahead": "Одне слово: було підготовлене наперед", "word-list": "Одне слово: зі словничка книжки", "word-name": "Одне слово: ім'я чи місце зі списку книжки", "open-book": "Відкрити книжку", "act-add": "Додати файл", "act-cover-photo": "Сфотографувати обкладинку", "act-free-all": "Вільна полиця: усі", "act-yakaboo": "Як додати з Yakaboo", "act-bookua": "Як додати з Book.ua", "bm-finished": "Меню книжки: прочитано", "bm-about": "Меню книжки: про книжку", "act-title-about": "У книжці: назва → про книжку", "act-intro-open": "Перед главою: відкрити", "act-intro-hide": "Перед главою: сховати", "bm-keep": "Меню книжки: на пристрій", "bm-share": "Меню книжки: поділитися", "bm-edit": "Меню книжки: назва, обкладинка", "bm-cover-find": "Меню книжки: знайти обкладинку", "cover-pick": "Обкладинка: поставили знайдену", "cover-file": "Обкладинка: свій файл", "cover-reset": "Обкладинка: як у файлі", "bm-epub": "Меню книжки: EPUB", "bm-delete": "Меню книжки: видалити", "note-add": "Нова нотатка", "btn-logout": "Вийти", "r-pnav-journey": "Панель: статистика", "r-pnav-scratch": "Панель: Scratchpad", "scr-write": "Scratchpad: записали", "act-scr-mic": "Scratchpad: голосом", "act-scr-photo": "Scratchpad: фото", "act-scr-book": "Scratchpad: картка книжки", "act-scr-add": "Scratchpad: додали книжку", "act-scr-guess": "Scratchpad: вибрали здогад", "act-scr-done": "Scratchpad: готово", "act-scr-skip": "Scratchpad: не цікаво", "act-scr-sorted": "Scratchpad: розібрані", "act-scr-delete": "Scratchpad: видалити", "act-scr-renew": "Scratchpad: повернути в нові", "intro-shown": "Перед главою: картка з'явилась", "intro-read": "Перед главою: розгорнули", "intro-gone": "Перед главою: зникла сама після 3 сторінок", "toc-go": "Зміст: перейшли до глави", "search-run": "Пошук у книжці: шукали", "search-go": "Пошук у книжці: перейшли до знайденого", psearch: "Пошук на панелі: шукали", "psearch-pick": "Пошук на панелі: відкрили знайдене", "gloss-book": "Словничок: відкрили книжку з ним", "gloss-nohl": "Словничок: книжка з ним, але пристрій не підкреслює (iOS до 17.2)", "act-gloss-start": "Підготувати словничок", "page-home": "Панель: мої книжки", "page-add": "Панель: додати книжку", "look-size": "Аа: розмір шрифту", "look-theme": "Аа: тема", "look-font": "Аа: шрифт", "look-margins": "Аа: поля", "look-spacing": "Аа: інтервал", "look-column": "Аа: ширина колонки", "look-pagetaps": "Аа: сторінки / прокрутка", "look-deskscroll": "Аа: сторінки / прокрутка (комп'ютер)", "look-gloss-on": "Аа: словничок «Менше»", "look-gloss-more": "Аа: словничок «Більше»", "look-gloss-off": "Аа: словничок вимкнули", "act-free-shelf": "Вільна полиця", "page-how": "Як це працює (паперові)", "done-shown": "Прочитано: картка з'явилась", "done-open": "Прочитано: форма відкрилась", "act-done-open": "Прочитано: тап на картку", "act-done-card-hide": "Прочитано: сховати картку", "act-done-star": "Прочитано: зірка", "act-done-send": "Прочитано: опублікувати", "act-done-hide": "Прочитано: закрити форму", "update-shown": "Нова версія: кнопка з'явилась", "update-go": "Нова версія: кнопка в шапці (телефон)", "update-go-panel": "Нова версія: кнопка на панелі (комп'ютер)", "set-update": "Налаштування: «Оновити» версію", "cover-card": "Обкладинка: картка книжки", "cover-card-add": "Обкладинка: додали з картки", "paper-page-num": "Паперова: вписали сторінку", "paper-page-photo": "Паперова: сторінка з фото" };
// Every feature of the reader in one table (Max 2026-11-19: «що у нас і як користуються або не користуються»): the
// tap names that mean it was used (`use`) and, where the reader is shown it first, those that mean they saw it
// (`seen`). A name ending in «*» takes every name that starts so. A new feature gets a row here.
const FEATURES = [
  ["Відкрили книжку", { use: ["open-book"] }],
  ["Пояснити / Запитати", { use: ["sel-explain", "sel-mic"] }],
  ["Пояснення під абзацом: розгорнули", { use: ["ask-open"] }],
  ["Перекласти", { use: ["sel-translate"] }],
  ["Словничок: підкреслене слово", { seen: ["gloss-book"], use: ["gloss"] }],
  ["Словничок: «Більше не показувати»", { use: ["act-gloss-know"] }],
  ["Словничок: «Менше / Більше / Ні»", { use: ["look-gloss-*"] }],
  ["Підготувати словничок", { use: ["act-gloss-start"] }],
  ["Одне слово (виділили)", { use: ["word"] }],
  ["Ім'я чи місце (виділили)", { use: ["word-name"] }],
  ["Перед главою: розгорнули", { seen: ["intro-shown"], use: ["intro-read"] }],
  ["Перед главою: сховали", { seen: ["intro-shown"], use: ["act-intro-hide"] }],
  ["Оновити до нової версії", { seen: ["update-shown"], use: ["update-go", "update-go-panel", "set-update"] }],
  ["Перед главою: зникла сама", { seen: ["intro-shown"], use: ["intro-gone"] }],
  ["Про книжку", { use: ["bm-about", "act-title-about"] }],
  ["Обкладинка: картка «Про книжку» → додали", { seen: ["cover-card"], use: ["cover-card-add"] }],
  ["Паперова: сторінка вписали / з фото", { use: ["paper-page-num", "paper-page-photo"] }],
  ["Зміст: перейшли до глави", { use: ["toc-go"] }],
  ["Пошук у книжці", { use: ["search-run"] }],
  ["Пошук у книжці: перейшли до знайденого", { use: ["search-go"] }],
  ["Пошук на панелі", { use: ["psearch"] }],
  ["Пошук на панелі: відкрили знайдене", { use: ["psearch-pick"] }],
  ["Нотатки: зберегли", { use: ["sel-note", "sel-mark-note", "note-add"] }],
  ["Нотатки: відкрили список", { use: ["btn-notes", "tab-notes"] }],
  ["Аа: вигляд", { use: ["look-size", "look-theme", "look-font", "look-margins", "look-spacing", "look-column", "look-pagetaps", "look-deskscroll", "btn-font-down", "btn-font-up"] }],
  ["Статистика", { use: ["r-pnav-journey"] }],
  ["Scratchpad: відкрили", { use: ["r-pnav-scratch"] }],
  ["Scratchpad: записали", { use: ["scr-write"] }],
  ["Scratchpad: записали голосом / з фото", { use: ["act-scr-mic", "act-scr-photo"] }],
  ["Scratchpad: розібрали (готово / не цікаво)", { use: ["act-scr-done", "act-scr-skip"] }],
  ["Scratchpad: книжка (картка / додали)", { use: ["act-scr-book", "act-scr-add"] }],
  ["Додати книжку", { use: ["act-add", "page-add"] }],
  ["Як це працює (паперові)", { use: ["page-how"] }],
  ["Вільна полиця", { use: ["act-free-shelf", "act-free-all"] }],
  ["Позначити прочитаною", { use: ["bm-finished"] }],
  ["Прочитано: відкрили форму", { seen: ["done-shown"], use: ["done-open"] }],
  ["Прочитано: опублікували на Chytai", { seen: ["done-shown"], use: ["act-done-send"] }],
  ["На пристрій (без мережі)", { use: ["bm-keep"] }],
  ["Знайти обкладинку: поставили", { seen: ["bm-cover-find"], use: ["cover-pick", "cover-file"] }],
];
// «Функції» rows from uiStats rows (index.js): readers who used it in 7 and 30 days (several names
// joined), taps in 30 days, Max's own, and readers who saw it where that is counted.
function featureRow(ui, [label, def]) {
  const pick = (names) => ui.filter((r) => names.some((x) => (x.endsWith("*") ? r.name.startsWith(x.slice(0, -1)) : r.name === x)));
  const sum = (rows) => {
    const who = new Set(), who7 = new Set();
    let n = 0, max = 0, guests = false;
    for (const r of rows) {
      for (const a of r.who || []) who.add(a);
      for (const a of r.who7 || []) who7.add(a);
      n += r.n || 0;
      max += r.max || 0;
      guests ||= !!r.guests;
    }
    return { readers: who.size, readers7: who7.size, n, max, guests };
  };
  return { label, use: sum(pick(def.use)), seen: def.seen ? sum(pick(def.seen)) : null };
}
const features = (ui) => (ui?.length && ui[0].who ? FEATURES.map((f) => featureRow(ui, f)) : []);

module.exports = { cost, features, UI_NAMES };
