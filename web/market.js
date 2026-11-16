// «Книжковий ринок України» (/market, Max 2026-11-16: «давай зробимо сторінку на сайті… з інфографікою, описом»).
// The numbers are copied by hand from open reports; nobody publishes a feed. To refresh: a new year of Книжкова
// палата (ukrbook.net/statistika_.html), УІК's yearly «Показники книжкової галузі» and its quarterly єКнига
// results (ubi.org.ua/uk/activity/doslidzhennya, ubi.org.ua/uk/news). Change UPDATED with the numbers.
const UPDATED = "16 листопада 2026";

// The headline numbers, 2025.
const NUMS = [
  { n: "8,9 млрд ₴", what: "дохід видавців", src: "УІК" },
  { n: "15 069", what: "назв книжок і брошур", src: "Книжкова палата" },
  { n: "33,2 млн", what: "примірників надруковано", src: "Книжкова палата" },
  { n: "4,2 млрд ₴", what: "продали книгарні", src: "Держстат" },
  { n: "≈390", what: "видавців", src: "УІК" },
  { n: "≈800", what: "книгарень", src: "УІК" },
];

// Книжкова палата: books and brochures by year (titles, thousands of copies).
const YEARS = [
  { y: 2021, titles: 21095, copies: 44753.6, ru: 2576 },
  { y: 2022, titles: 9691, copies: 11704.2, ru: 762 },
  { y: 2023, titles: 15187, copies: 24664.0, ru: 700 },
  { y: 2024, titles: 14500, copies: 34017.2, ru: 472 },
  { y: 2025, titles: 15069, copies: 33210.7, ru: 260 },
];

// Книжкова палата 2025 by subject, the biggest; «Інше» = the rest of the table.
const SUBJECTS = [
  { name: "Освіта й культура (здебільшого підручники)", titles: 2390, copies: 17243.3 },
  { name: "Художня література", titles: 4496, copies: 8333.5 },
  { name: "Для дітей", titles: 1918, copies: 4206.1 },
  { name: "Суспільство, політика, економіка", titles: 3369, copies: 2309.2 },
  { name: "Медицина", titles: 535, copies: 355.8 },
  { name: "Наука й техніка", titles: 1264, copies: 403.3 },
  { name: "Інше", titles: 1097, copies: 359.5 },
];

// Книжкова палата 2025: print runs.
const RUNS = [
  { name: "до 500", titles: 7203, copies: 1370.6 },
  { name: "500–1 000", titles: 1576, copies: 1520.9 },
  { name: "1 000–5 000", titles: 3850, copies: 10261.9 },
  { name: "5 000–10 000", titles: 546, copies: 4246.6 },
  { name: "10 000–50 000", titles: 455, copies: 8087.7 },
  { name: "понад 50 000", titles: 52, copies: 7723.0 },
];

// єКнига, January – September 2026 (УІК, «Підсумки реалізації програми станом на 01 жовтня 2026 року»).
const YEK = {
  period: "січень – вересень 2026",
  books: 171337,
  titles: 21430,
  pubCount: 388,
  online: 73, // % of the money
  // The most bought, from УІК's open table: copies, title, author, ISBNs for finding our page.
  top: [
    { n: 1980, title: "Гра в кота і мишу. Книга 1: Переслідування Аделіни", author: "Х. Д. Карлтон", isbns: ["9786175481820"] },
    { n: 1602, title: "Людина в пошуках справжнього сенсу", author: "Віктор Франкл", isbns: ["9786171204522", "9786171206526", "9786171285835"] },
    { n: 1225, title: "Стіни в моїй голові", author: "Володимир Станчишин", isbns: ["9786177960026", "9786177960057", "9786178782849"] },
    { n: 1176, title: "Гра в кота і мишу. Книга 2: Полювання на Аделіну", author: "Х. Д. Карлтон", isbns: ["9786175482308"] },
    { n: 1154, title: "Тією горою є ви", author: "Бріанна Вест", isbns: ["9786175480892"] },
    { n: 1108, title: "Покинь, якщо кохаєш", author: "Коллін Гувер", isbns: ["9789669425140"] },
    { n: 1069, title: "Хірург", author: "Тесс Ґеррітсен", isbns: ["9786171214620", "9786171219786", "9786171286306", "9786171520684", "9786171519992"] },
    { n: 1034, title: "Я бачу, вас цікавить пітьма", author: "Ілларіон Павлюк", isbns: ["9786176798323"] },
    { n: 867, title: "Якби він був зі мною", author: "Лора Новлін", isbns: ["9786178280970"] },
    { n: 838, title: "Атомні звички", author: "Джеймс Клір", isbns: ["9789669483751", "9789669488237"] },
    { n: 825, title: "Іди туди, де страшно", author: "Джим Ловлесс", isbns: ["9786175480595"] },
    { n: 817, title: "Огидне кохання", author: "Коллін Гувер", isbns: ["9786178373962"] },
  ],
  // Copies of all their books in the table (summed by the author's name as written there).
  authors: [
    { name: "Коллін Гувер", n: 4908 },
    { name: "Х. Д. Карлтон", n: 3736 },
    { name: "Пенелопа Дуглас", n: 3543 },
    { name: "Тесс Ґеррітсен", n: 3084 },
    { name: "Бріанна Вест", n: 2185 },
    { name: "Володимир Станчишин", n: 1652, uk: true },
    { name: "Віктор Франкл", n: 1602 },
    { name: "Саймон Бекетт", n: 1387 },
    { name: "Ілларіон Павлюк", n: 1379, uk: true },
    { name: "Аґата Крісті", n: 1210 },
  ],
  // The top 100 books: share of copies.
  kinds: [
    { name: "Художня", pct: 72.6 },
    { name: "Нонфікшн", pct: 22.8 },
    { name: "Інше", pct: 4.7 },
  ],
  origin: [
    { name: "Перекладні", pct: 86 },
    { name: "Українських авторів", pct: 14 },
  ],
  publishers: [
    { name: "КСД", pct: 20.8 },
    { name: "BookChef", pct: 10.8 },
    { name: "Vivat", pct: 10.0 },
    { name: "Ранок", pct: 6.9 },
    { name: "Видавництво РМ", pct: 4.5 },
    { name: "Наша ідея", pct: 3.5 },
    { name: "Видавництво Старого Лева", pct: 3.4 },
    { name: "Фоліо", pct: 3.1 },
    { name: "Віхола", pct: 2.4 },
    { name: "Наш формат", pct: 2.1 },
  ],
  shops: [
    { name: "КСД", pct: 24.0 },
    { name: "Yakaboo", pct: 20.4 },
    { name: "Книгарня «Є»", pct: 20.3 },
    { name: "MEGOGO BOOKS", pct: 14.0 },
    { name: "Книголенд", pct: 6.0 },
  ],
};

// Мінкульт / Gradus Research, «Читання в Україні» (October 2026, 2 200 people aged 14+).
const READING = {
  often: [
    { name: "Щодня або майже щодня", pct: 12 },
    { name: "Кілька разів на тиждень", pct: 21 },
    { name: "Кілька разів на місяць", pct: 26 },
    { name: "Рідше", pct: 28 },
    { name: "Жодного разу за рік", pct: 13 },
  ],
  choose: [
    { name: "Читали інші книжки автора", pct: 32 },
    { name: "Порадили друзі чи знайомі", pct: 29 },
    { name: "Анотація й опис", pct: 26 },
    { name: "Відгуки на сайтах і в соцмережах", pct: 25 },
  ],
};

const SOURCES = [
  { name: "Книжкова палата України: випуск видань за рік", url: "https://ukrbook.net/statistika_.html", what: "Назви й наклади за темами, мовами, областями, з 2011 року. PDF." },
  { name: "УІК: «Показники книжкової галузі України 2025»", url: "https://ubi.org.ua/uk/activity/doslidzhennya/doslidzhennya-2026", what: "Доходи видавців, книгарні, тенденції. PDF, травень 2026." },
  { name: "УІК: підсумки «єКниги»", url: "https://ubi.org.ua/uk/news/kategoriya-1/scho-obirayut-18-richni-ukra-nci-za-programoyu-kniga-pidsumki-programi-za-3-kvartali-2026-roku", what: "Що купують 18-річні: таблиця на 11 тисяч назв із кількістю, щокварталу." },
  { name: "Мінкульт / Gradus: «Читання в Україні»", url: "https://ubi.org.ua/uk/news/kategoriya-2/doslidzhennya-chitannya-vid-minkultu-scho-de-i-yak-chasto-chitayut-ukra-nci", what: "Як часто читають і як обирають книжки. Жовтень 2026." },
  { name: "Держстат через «Слово і діло»", url: "https://www.slovoidilo.ua/2026/05/28/infografika/suspilstvo/yak-aktyvno-ukrayinczi-kupuvaly-knyhy-povnomasshtabnoyi-vijny", what: "Скільки продали книгарні за рік." },
  { name: "Forbes Ukraine: Артем Біденко про стан галузі", url: "https://forbes.ua/lifestyle/maybutne-knizhkovoi-galuzi-ukraini-pid-zagrozoyu-uik-kazhe-shcho-vona-zrostae-ale-naspravdi-tse-ne-tak-analiz-rinku-vid-artema-bidenka-z-vidavnichoi-asotsiatsii-20112025-34298", what: "Погляд видавців, що не погоджуються з УІК." },
];

// The top books as our pages where the catalog has them (by ISBN, else title + author). Kept an hour.
let cache = { at: 0, out: null };
function topBooks(store) {
  if (cache.out && Date.now() - cache.at < 60 * 60 * 1000) return cache.out;
  const out = YEK.top.map((t) => {
    let id = null;
    try {
      id = store.findWork({ title: t.title, author: t.author, isbns: t.isbns });
    } catch {}
    const book = id && store.book(id);
    return { ...t, book: book || null };
  });
  cache = { at: Date.now(), out };
  return out;
}

module.exports = { UPDATED, NUMS, YEARS, SUBJECTS, RUNS, YEK, READING, SOURCES, topBooks };
