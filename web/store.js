// Data for the Chytai web platform: the library (every reader's entries, by reader id), the public shelves and the
// book registry, kept in SQLite (db.js, DATA_DIR/web/chytai.db) and cached in memory, where editions,
// series and addresses are derived. The library was seeded once from web/seed/max.json (Books.md
// import) and web/seed/office.json (the paper books in Max's office); Books.md is not read again
// after that (Max, 2026-10-18). A library.json or shelves.json from before the database is imported
// on the first start and renamed to *.migrated.
const fs = require("fs");
const path = require("path");
const { open } = require("./db");

const SEED = path.join(__dirname, "seed");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// Office books that match a library book under a different spelling (title-matching misses them).
const OFFICE_MATCHES = { 6: "bastiat-essays", 7: "гемінгвей-нічого-не-знає", 35: "deep-work", 44: "subtle-art-of-not-giving-a-fuck", 46: "andy-grove-one-on-ones" };
// Russian-only letters; «ье» (Ukrainian writes «ьє»: «12 стульев») and the initial «И.» (Ukrainian «І.»: «И. Ильф») too.
const RU = /[ыэъёЫЭЪЁ]|[ьЬ][еЕ]|(?<![\p{L}])И\./u; // these office books stay out of the profile until Max says otherwise
const FMT = (f) => (f === "аудіо" ? 2 : f === "e-book" ? 1 : 0); // print first, then e-book, then audio
const PICK = { "": 0, "є": 1, передзамовлення: 2, анонс: 3, немає: 4 }; // which edition stands for the work on a shelf

// Ukrainian national transliteration (КМУ 2010), so an address stays readable when copied: Cyrillic
// in a link turns into %D1%8F… (Max, 2026-10-19). Є, Ї, Й, Ю, Я start a word as ye, yi, y, yu, ya.
const LAT = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ъ: "", ё: "io" };
const FIRST = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
function translit(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const start = !/[\p{L}’'ʼ]/u.test(s[i - 1] || "");
    if (c === "з" && s[i + 1] === "г") (out += "zgh"), i++;
    else out += (start && FIRST[c]) || (LAT[c] ?? c);
  }
  return out;
}
const slugify = (s) =>
  translit(String(s).toLowerCase())
    .replace(/[łđøß]/g, (c) => ({ ł: "l", đ: "d", ø: "o", ß: "ss" })[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’'"«»“”ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
const OWNER = "owner"; // the reader id of the owner (Max): the only reader before accounts, so old rows are his
// Books in Russian stay on the shelf of the reader who added them and nowhere else: not in search,
// author pages, feeds, picks or recommendations (Max, 2026-10-20: «не показувати книжки рос в пошуку.
// Навіть якщо хтось її додав. Тільки на сторінці цього читача»). The catalog's language word wins,
// otherwise the Russian-only letters ы э ъ ё in the title or the author, or, with no Ukrainian-only
// letter, a Russian ending: «Ненасильственное общение» has neither ы nor э.
const RU_ENDING = /(ое|ая|ые|ие)(?![\p{L}])|(?<![\p{L}])(и|что|как|это|лет|или)(?![\p{L}])/iu;
// Writers whose books here are in Russian whatever the letters say («Черновик», Sergei Lukyanenko: Max,
// 2026-10-23 «не хочу бачити цю русняву г в рекомендаціях»), in Cyrillic and Latin spellings.
const RU_AUTHOR = /лук[ья'’ʼ]{0,2}[яа]ненко|lukyanenko|lukianenko|пелев[иі]н|pelevin|акун[иі]н|akunin|донцова|dontsova|прилеп[иі]н|prilepin|лимонов|limonov|маринина|marinina|устинова|ustinova|перумов|perumov|головач[её]в|golovachev|дугин|dugin|стругацк|strugatsk|булыч[её]в|bulychev|bulychov|ефремов|yefremov|efremov|беляев|belyaev|beliaev|гончаров|goncharov|солженицын|solzhenitsyn|шукшин|shukshin|улицкая|ulitskaya|глуховск|glukhovsk|пикуль|pikul|роберт штильмарк/iu;
// A Cyrillic title with the author written the Russian way in Latin («Sergei», not «Serhii»).
const RU_LATIN_NAME = /^(arkady|arkadi|boris|sergei|sergey|aleksei|alexei|alexey|aleksey|dmitry|dmitri|nikolai|yevgeny|evgeny|vasily|vasiliy|mikhail|pyotr|fyodor|yuri|yury|grigory|alexandr)\b/i;
// Russian and Ukrainian word forms, for a Cyrillic title with none of і ї є ґ (Max, 2026-10-23: «прогнати
// через простий фільтр слів, типу кава або кофе»): langGuess() says "ru", "uk" or "" when it can't tell.
const WB = "(?<![\\p{L}])", WE = "(?![\\p{L}])";
const RU_WORDS = new RegExp(`${WB}(и|из|из-под|от|о|об|как|что|чтобы|это|кто|они|она|оно|его|её|ее|под|после|между|уже|ещё|еще|только|нет|жизнь|жизни|ведь|кофе|человек|человека|сквозь|вокруг|себя|себе|тебя|меня|трех|двух|две|сердца|где|когда|почему|зачем|путь|ночь|ночью|мечты|мечта|война)${WE}`, "iu");
const RU_FORMS = new RegExp(`(ость|ости|ние|ния|нию|ниями|ниях|ия|ии|ию|ией|иям|иях|ие|ью|ный|ная|ное|ные|ной|ных)${WE}|russian edition|\\p{L}сс\\p{L}|\\p{L}мм\\p{L}`, "iu");
const UK_WORDS = new RegExp(`${WB}(та|що|це|як|із|зі|від|під|або|чи|й|вже|ще|мій|моя|наш|людина|дитини|пригоди|казки)${WE}`, "iu");
const UK_FORMS = new RegExp(`[’'ʼ][яюєї]|ння|ття|сся|лля|ддя|жжя|ччя|шшя|ць|ця${WE}|цю${WE}`, "iu");
const langGuess = (title) => {
  const t = String(title || "");
  if (/[іїєґ]/i.test(t)) return "uk";
  const uk = UK_WORDS.test(t) || UK_FORMS.test(t);
  const ru = RU.test(t) || RU_WORDS.test(t) || RU_FORMS.test(t);
  return ru && !uk ? "ru" : uk && !ru ? "uk" : "";
};
const isRussian = (b) => {
  const lang = String(b?.language || "").toLowerCase();
  // A Ukrainian translation of such a writer is a Ukrainian book; anything else of theirs is not.
  if (RU_AUTHOR.test(b?.author || "") && !/^(uk|укр)/.test(lang) && !/[іїєґ]/i.test(b?.title || "")) return true;
  if (lang) return /^(ru|рос)/.test(lang);
  const text = `${b?.title || ""} ${b?.author || ""}`;
  if (/[а-яё]/i.test(b?.title || "") && langGuess(b.title) === "ru") return true;
  if (/[а-яё]/i.test(b?.title || "") && !/[іїєґ]/i.test(b?.title || "") && RU_LATIN_NAME.test(String(b?.author || "").trim())) return true;
  return RU.test(text) || (!/[іїєґ]/i.test(text) && RU_ENDING.test(b?.title || ""));
};
// Which original Haiku named is worth naming: not a Russian one (Max 2026-10-23: «не додаємо оригінал якщо він
// рос»), and not one in an ancient language or a script a reader here can't read or search («Πολιτεία», Max:
// «сумніваюсь щодо таких»). Only a title in Latin letters, in a living language.
const origShown = (r) => {
  const ok = r.kind === "translation" && !/^(ru|rus|russian|рос)/i.test(r.lang || "") && !/ancient|classical|old|medieval|middle|latin|^la$|^grc$/i.test(r.lang || "") && /\p{Script=Latin}/u.test(r.title || "") && !/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}\p{M}]/u.test(r.title || "");
  return { ...r, title: ok ? r.title : "", author: ok ? r.author : "" };
};
const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Separators left at the end of a title: «Diary of Samuel Pepys -», «Назва:».
const DANGLING = /[\s\-‐‑–—:;,/|]+$/u;
const EDITABLE = ["title", "author", "blurb", "cover", "language", "aliases", "genre", "published"];
// A short name as typed in search: «DCC», «Л.О.Т.Р.» and «lotr» are one key.
const aliasKey = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// The first letters of a name of three or more words, as readers shorten it: «Dungeon Crawler Carl» → dcc,
// «A Song of Ice and Fire» → asoiaf and soiaf, «The Lord of the Rings» → lotr and tlotr. The main title
// only («Dungeon Crawler Carl: …»).
function acronyms(name) {
  const words = String(name || "").split(/[.:(]\s/)[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => /^\p{L}/u.test(w));
  const out = new Set();
  for (const ws of [words, /^(the|a)$/.test(words[0]) ? words.slice(1) : []]) if (ws.length >= 3 && ws.length <= 7) out.add(ws.map((w) => w[0]).join(""));
  return [...out];
}
// Our genres (pages.js GENRES) in a shop's shelf names («Фентезі», «Художня література», «Науково-популярна»)
// and in Open Library's English subjects; the specific ones first, «художня» last.
const SHOP_GENRES = [
  ["дитячі", /дитяч|для дітей|казк|children|juvenile/i],
  ["підліткові", /підлітк|young adult|teen/i],
  ["комікси", /комікс|манґ|манга|графічн|comic|graphic novel/i],
  ["фентезі", /фентез|фэнтез|fantasy/i],
  ["фантастика", /фантаст|антиутоп|science[ -]fiction|sci-fi|dystopia/i],
  ["жахи", /жах|horror/i],
  ["детективи", /детектив|detective|mystery/i],
  ["трилери", /трилер|thriller/i],
  ["любовні романи", /любовн|романтичн|romance/i],
  ["поезія", /поезі|вірш|poetry/i],
  ["класика", /класик|classic/i],
  ["біографії", /біограф|мемуар|спогад|biograph|memoir/i],
  ["історія", /історі|історичн|\bhistory\b|historical/i],
  ["війна", /війн|військ|\bwar\b|military/i],
  ["психологія", /психолог|psycholog/i],
  ["філософія", /філософ|philosoph/i],
  ["наука", /наука|науков|science(?!.*fiction)/i],
  ["здоров'я", /здоров|медицин|харчуван|\bhealth\b/i],
  ["подорожі", /подорож|травел|travel/i],
  ["саморозвиток", /саморозвит|мотивац|особистісн|self-help/i],
  ["бізнес", /бізнес|підприємни|стартап|business/i],
  ["менеджмент", /менеджмент|лідерств|management|leadership/i],
  ["гроші", /фінанс|гроші|інвест|finance|investing/i],
  ["розробка", /програмуван|programming|software/i],
  ["суспільство", /соціолог|політик|політолог|економік|суспільств|sociology|politics|economics/i],
  ["художня", /художн|проза|(?<!non-?)fiction|novels?\b/i],
];
const OUR_GENRES = new Set(SHOP_GENRES.map(([g]) => g).concat(["компанії", "продукт"]));
const genreMemo = new Map();
const ourGenres = (names) => {
  const out = new Set();
  for (const n of names || []) {
    const k = String(n || "").toLowerCase().trim();
    if (!genreMemo.has(k)) genreMemo.set(k, OUR_GENRES.has(k) ? [k] : /нон-?фікшн|non-?fiction|документальн/i.test(k) ? SHOP_GENRES.filter(([g, re]) => g !== "художня" && re.test(k)).map(([g]) => g) : SHOP_GENRES.filter(([, re]) => re.test(k)).map(([g]) => g));
    for (const g of genreMemo.get(k)) out.add(g);
  }
  return [...out];
};
// The genres a book is shown under (Max, 2026-10-23: «може просто показувати два»): its first two of ours,
// «художня» only when nothing more specific; the owner's main genre («Редагувати») comes first.
const mainGenres = (tags) => {
  const ours = (tags || []).filter((t) => OUR_GENRES.has(t));
  const specific = ours.filter((t) => t !== "художня");
  return (specific.length ? specific : ours).slice(0, 2);
};
const isbnKey = (s) => String(s || "").replace(/[^0-9X]/gi, "");
const GENRE = /\s*[:.]\s*(казка|казки|роман|повість|повісті|оповідання|новели|п[’']єса|есеї|есей|поезії|вірші|збірка|нариси|спогади|мемуари|(осіннє|зимове|весняне|літнє|подарункове|ювілейне|ілюстроване|нове|повне|доповнене|колекційне)\s+видання)\s*$/iu;
// A note on the edition at the end of a title, which names a printing, not a book: «Дракула (2-ге видання)»,
// «Подолати минуле: глобальна історія України Подарункове видання», «Кобзар. Ювілейне видання».
const EDITION = /[\s:.,]*(?:[(\[]\s*)?(\d+-?[а-яі]{1,3}\s+(видання|вид\.?)|(осіннє|зимове|весняне|літнє|подарункове|ювілейне|ілюстроване|нове|повне|доповнене|виправлене|оновлене|колекційне|святкове|лімітоване|спеціальне|перше|друге|третє)(\s+(та|і|й)\s+(доповнене|виправлене|оновлене|перероблене))?\s+видання)\s*[)\]]?\s*$/iu;
// The name of the work a shop's title stands for: without a bracketed note («(м'яка обкладинка)»), a genre
// word or an edition note at its end. A bracket with a number or a volume word stays («(том 2)», «(1984)»),
// unless it is an edition («(2-ге видання)»); volumes never fold into one book.
// A shop's promo prefix is not part of the name either: «Акція (−10%): Пісня Ахілла» (Max, 2026-10-22).
const PROMO = /^\s*(акція|знижка|розпродаж|суперціна|спецціна)(?=[\s(:])[^:]{0,20}:\s*/iu;
const workName = (t) =>
  String(t || "")
    .replace(PROMO, "")
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => (/\d|том|книга|частина|част\./i.test(inner) && !/видання|вид\./i.test(inner) ? m : ""))
    .replace(GENRE, "")
    .replace(EDITION, "")
    .replace(GENRE, "")
    .trim();
// The ISBNs a library book is known by: its own field, plus the Amazon /dp/<ISBN-10> links from Books.md.
const isbnsOf = (b) => [...(b.isbns || []), b.isbn || "", ...(b.links || []).map((l) => /amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/([0-9X]{10})/i.exec(l.url || "")?.[1] || "")].map(isbnKey).filter((i) => i.length >= 10);

// Levenshtein distance, giving up once it is past max.
// A rough sound of a word, the same for «міллер» and «miller», «оруелл» and «orwell», «гемінгвей» and «hemingway»:
// Cyrillic is spelled out in Latin letters, Latin spellings that Ukrainian writes one way are folded (c/k,
// ph/f, w/v, y/i, g/h, au/o…), double letters become one. Only for search, never shown.
const SOUND = { а: "a", б: "b", в: "v", г: "h", ґ: "h", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "i", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "i", э: "e", ё: "io", ъ: "", "’": "", "'": "", ʼ: "" };
function soundOf(word) {
  const w = String(word).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const latin = /[a-z]/.test(w) && !/[а-яіїєґ]/.test(w);
  let s = latin
    ? w
        .replace(/sch/g, "sh")
        .replace(/ph/g, "f")
        .replace(/ck/g, "k")
        .replace(/kh/g, "h")
        .replace(/th/g, "t")
        .replace(/ay|ai|ey/g, "ei")
        .replace(/au/g, "o")
        .replace(/oo/g, "u")
        .replace(/ee|ea|ie/g, "i")
        .replace(/([^aeiouy])e$/, "$1")
        .replace(/c(?=[eiy])/g, "s")
        .replace(/[cq]/g, "k")
        .replace(/x/g, "ks")
        .replace(/w/g, "v")
        .replace(/j/g, "dzh")
        .replace(/y/g, "i")
        .replace(/g/g, "h")
    : [...w].map((c) => SOUND[c] ?? c).join("");
  return s.replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
}

function editDistance(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Do two author strings name the same person? Names are compared transliterated, so «Метт Рідлі» is
// Matt Ridley, and a typo or a different spelling («Khvylovy»/«Хвильовий») is allowed two letters.
// A side without a name cannot disagree.
const authorNames = (a) =>
  norm(a)
    .split(" ")
    .filter((w) => w.length >= 3)
    .map((w) => (/[а-яіїєґ]/.test(w) ? translit(w).replace(/[^a-z]/g, "") : w.normalize("NFKD").replace(/\p{M}/gu, "")));
function sameAuthor(a, b) {
  const mine = authorNames(a);
  const theirs = authorNames(b);
  if (!mine.length || !theirs.length) return true;
  return mine.some((m) => theirs.some((t) => m === t || (m.length >= 4 && t.length >= 4 && editDistance(m, t, 2) <= 2)));
}

// Two entries for one work (one saved under an edition id): keep the fuller of each field.
const RANK = { read: 3, abandoned: 2.5, reading: 2, want: 1, "": 0 };
function mergeEntries(a, b) {
  const pick = (x, y) => (x !== "" && x != null ? x : y);
  return { ...b, ...a, status: (RANK[a.status] ?? 0) >= (RANK[b.status] ?? 0) ? a.status : b.status, rating: Math.max(a.rating ?? -1, b.rating ?? -1) < 0 ? null : Math.max(a.rating ?? 0, b.rating ?? 0), year: pick(a.year, b.year), note: (a.note || "").length >= (b.note || "").length ? a.note || "" : b.note, copy: pick(a.copy, b.copy), order: Math.min(a.order ?? 1e9, b.order ?? 1e9), ...(a.kids || b.kids ? { kids: true } : {}) };
}

// One series inside another of the same name (Wikidata's «Foundation Trilogy» inside «Foundation», a
// saga inside «The Witcher»): wikidata.seriesOf gives each work its smallest series, so the trilogy's books
// and the later volumes landed in two series and a reader's shelf showed Foundation as two rows (a reader,
// 2026-10-24). Such a series goes into the bigger one, each volume at its place there: qid -> { to, n: Map }.
// Only when every volume of the small one is in the big one and the names agree once «trilogy», «saga»,
// «series» are dropped, so Mistborn stays apart from the Cosmere.
function nestedSeries(series) {
  const core = (s) => norm(String(s || "").replace(/\b(the|series|saga|trilogy|cycle|sequence|universe|novels|books)\b|(серія|цикл|сага|трилогія|всесвіт)/giu, " "));
  const key = (m) => [m.en && norm(m.en), m.uk && norm(m.uk)].filter(Boolean);
  const out = new Map();
  const list = Object.entries(series);
  for (const [a, sa] of list) {
    let best = null;
    for (const [b, sb] of list) {
      if (a === b || sb.members.length <= sa.members.length) continue;
      const names = [sa.name, sa.uk].map(core).filter(Boolean);
      const bigNames = [sb.name, sb.uk].map(core).filter(Boolean);
      if (!names.some((x) => bigNames.some((y) => x === y || x.startsWith(`${y} `) || x.endsWith(` ${y}`)))) continue;
      const n = new Map();
      for (const m of sa.members) {
        const hit = sb.members.find((x) => key(x).some((k) => key(m).includes(k)));
        if (!hit) break;
        n.set(m.n, hit.n);
      }
      if (n.size === sa.members.length && (!best || sb.members.length > best.size)) best = { to: b, n, size: sb.members.length };
    }
    if (best) out.set(a, best);
  }
  return out;
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "chytai.db");
    this.db = open(dataDir);
    this.seedBooks = readJson(path.join(SEED, "books.json"));
    this.importOld();
    this.load();
    this.loadShelves();
  }

  // ---- first start on the database: bring over the JSON files ----
  importOld() {
    const db = this.db;
    if (!db.get("library_imported")) {
      const file = path.join(this.dir, "library.json");
      let lib;
      try {
        lib = readJson(file);
      } catch {
        lib = this.seed();
      }
      db.tx(() => {
        for (const b of Object.values(lib.books || {})) db.prepare("INSERT OR REPLACE INTO books (id, data) VALUES (?, ?)").run(b.id, JSON.stringify(b));
        for (const [id, e] of Object.entries(lib.entries || {})) this.writeEntry(OWNER, id, e);
        for (const s of lib.subscriptions || []) db.prepare("INSERT OR IGNORE INTO subscriptions (reader, shelf) VALUES (?, ?)").run(OWNER, s);
        db.set("library_imported", new Date().toISOString());
      });
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
    }
    // The shelves: the seed, or the newer copy a refresh wrote under dataDir before the database.
    const seedShelves = readJson(path.join(SEED, "shelves.json"));
    if (!db.get("baseline")) db.set("baseline", seedShelves.baseline || seedShelves.fetched);
    if (!db.get("shelves_imported")) {
      const file = path.join(this.dir, "shelves.json");
      let shelvesFile = seedShelves;
      try {
        const live = readJson(file);
        if (live.fetched >= seedShelves.fetched) shelvesFile = live;
      } catch {
        /* no refresh yet */
      }
      let seen = {};
      try {
        seen = readJson(path.join(this.dir, "catalog-seen.json"));
      } catch {
        /* every item counts as seen on the shelves' date */
      }
      this.saveShelves(shelvesFile.shelves, { fetched: shelvesFile.fetched, refreshedAt: shelvesFile.refreshedAt || "", seen });
      db.set("shelves_imported", new Date().toISOString());
      for (const f of ["shelves.json", "catalog-seen.json"]) if (fs.existsSync(path.join(this.dir, f))) fs.renameSync(path.join(this.dir, f), path.join(this.dir, `${f}.migrated`));
    }
  }

  get baseline() {
    return this.db.get("baseline");
  }

  // When each catalog item was first seen (for «нове»).
  seen() {
    return Object.fromEntries(this.db.prepare("SELECT id, first_seen FROM items").all().map((r) => [r.id, r.first_seen]));
  }

  // Write fresh shelves (the whole catalog of each source given; other shelves stay as they are).
  saveShelves(shelves, { fetched, refreshedAt = "", seen = {} }) {
    const db = this.db;
    const today = fetched || new Date().toISOString().slice(0, 10);
    db.tx(() => {
      for (const s of shelves) {
        const { items, ...meta } = s;
        db.prepare("INSERT INTO shelves (id, data, refreshed_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, refreshed_at = excluded.refreshed_at").run(s.id, JSON.stringify(meta), refreshedAt);
        db.prepare("CREATE TEMP TABLE IF NOT EXISTS keep (id TEXT PRIMARY KEY)").run();
        db.prepare("DELETE FROM keep").run();
        const up = db.prepare("INSERT INTO items (id, shelf, data, first_seen, last_seen, ord) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET shelf = excluded.shelf, data = excluded.data, last_seen = excluded.last_seen, ord = excluded.ord");
        items.forEach((it, i) => {
          const { href, editions, volumes, ...data } = it; // derived on load
          up.run(it.id, s.id, JSON.stringify(data), seen[it.id] || today, today, i);
          db.prepare("INSERT OR IGNORE INTO keep (id) VALUES (?)").run(it.id);
        });
        db.prepare("DELETE FROM items WHERE shelf = ? AND id NOT IN (SELECT id FROM keep)").run(s.id);
      }
      db.set("fetched", today);
      if (refreshedAt) db.set("refreshed_at", refreshedAt);
    });
  }

  // Read the shelves back (at start and after every refresh) and rebuild everything derived.
  loadShelves() {
    const { SOURCES } = require("./catalogs");
    const order = SOURCES.map((s) => s.id);
    // A draft shelf is draft while its source says so (catalogs.js).
    const draft = new Set(SOURCES.filter((s) => s.draft).map((s) => s.id));
    const shelves = this.db
      .prepare("SELECT id, data FROM shelves")
      .all()
      .map((r) => ({ ...JSON.parse(r.data), draft: draft.has(r.id), items: [] }))
      .filter((s) => order.includes(s.id)) // a source that was removed (Standard Ebooks) leaves its rows behind, unseen
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const byId = new Map(shelves.map((s) => [s.id, s]));
    // Names saved before a catalog's entities were decoded («Neurosurgeon&#x27;s Journey») are decoded here.
    const { ent } = require("./catalogs");
    for (const r of this.db.prepare("SELECT shelf, data FROM items ORDER BY shelf, ord").all()) {
      const it = JSON.parse(r.data);
      for (const k of ["title", "altTitle", "author", "series", "translator", "publisher"]) if (typeof it[k] === "string" && it[k].includes("&")) it[k] = ent(it[k]);
      byId.get(r.shelf)?.items.push(it);
    }
    this.shelves = shelves;
    this.shelvesFetched = this.db.get("fetched") || "";
    this.shelvesRefreshedAt = this.db.get("refreshed_at") || "";
    this.shelfItems = new Map(); // item id -> { shelf, item }
    for (const s of this.shelves) for (const it of s.items) this.shelfItems.set(it.id, { shelf: s, item: it });
    this.linkEditions();
    this.migrateEntries();
    this.indexSlugs();
    this.pickCovers();
    this.linkTranslations();
    this.indexSearch();
    this.seedMerges();
  }

  // Merges written into matches.json «merges» ([keep, dup], ids or /book/ slugs) when the owner asks in
  // chat (Max, 2026-10-23: «залишимо одного Графа»): each pair goes into the owner's decisions once, as if
  // «Лишити цю» was pressed on /admin/dupes, so it can be undone there and an undo sticks.
  seedMerges() {
    let pairs = [];
    try {
      pairs = readJson(path.join(SEED, "matches.json")).merges || [];
    } catch {
      /* none */
    }
    let done;
    try {
      done = new Set(JSON.parse(this.db.get("merges:seeded") || "[]"));
    } catch {
      done = new Set();
    }
    const d = this.decisions();
    let changed = false;
    for (const [keep, dup] of pairs) {
      const key = `${keep}|${dup}`;
      if (done.has(key)) continue;
      const k = this.workId(keep);
      const x = this.workId(dup);
      if (!this.isWork(k) || !this.isWork(x)) continue; // not in the catalogs yet: tried again on the next load
      done.add(key);
      if (k === x || d.same.some(([a, b]) => a === k && b === x)) continue;
      d.same.push([k, x]);
      changed = true;
    }
    if (changed) {
      this.saveDecisions(d);
      this.indexSlugs();
      this.pickCovers();
    }
    // Hand edits asked in chat («Пригоди Шерлока Холмса» without «Том I», «Артур Конан Дойль»), matches.json
    // «edits» {slug: {title, author, …}}: put once into the owner's edits, as if made on /admin/book/:id.
    let edits = {};
    try {
      edits = readJson(path.join(SEED, "matches.json")).edits || {};
    } catch {
      /* none */
    }
    for (const [slug, fix] of Object.entries(edits)) {
      const key = `edit:${slug}:${JSON.stringify(fix)}`;
      if (done.has(key)) continue;
      const id = this.workId(slug);
      if (!this.isWork(id)) continue;
      done.add(key);
      this.editBook(id, { ...(this.edits()[id] || {}), ...fix });
    }
    this.db.set("merges:seeded", JSON.stringify([...done]));
  }

  // A book and its translation are two works, linked: each page points at the other, and having read
  // one counts for the other (Max, 2026-10-19: «якщо читав одну то автоматично і другу теж»). Linked
  // when one's original title is the other's title, or by hand in matches.json «translations».
  linkTranslations() {
    this._titles = null; // titleIndex() and workIndex() are rebuilt with the new shelves
    this._works = null;
    this.translations = new Map(); // work id -> Set of work ids
    const link = (a, b) => {
      a = a && this.canonical(a);
      b = b && this.canonical(b);
      if (!a || !b || a === b) return;
      for (const [x, y] of [[a, b], [b, a]]) (this.translations.get(x) || this.translations.set(x, new Set()).get(x)).add(y);
    };
    const works = [...this.seedBooks, ...Object.values(this.lib.books), ...[...this.shelfItems.values()].filter(({ item }) => this.canonical(item.id) === item.id && !this.hidden.has(item.id)).map(({ item }) => item)];
    const byTitle = new Map();
    for (const w of works) if (norm(w.title).length >= 4) (byTitle.get(norm(w.title)) || byTitle.set(norm(w.title), []).get(norm(w.title))).push(w);
    for (const w of works) for (const o of byTitle.get(norm(w.altTitle)) || []) link(w.id, o.id); // the same work already shares one id
    // A foreign book's Ukrainian title from Wikidata (wikidata.js): a book of that title by the same author.
    this.ukTitles = JSON.parse(this.db.get("wikidata:uk") || "{}");
    const names = (a) => norm(a).split(" ").filter((w) => w.length >= 3);
    // A catalog title with a subtitle («Розумний інвестор. Стратегія вартісного інвестування») counts by its main part.
    const byMain = new Map();
    for (const w of works) {
      const m = norm(String(w.title || "").split(/[.:]\s/)[0]);
      if (m.length >= 4 && m !== norm(w.title)) (byMain.get(m) || byMain.set(m, []).get(m)).push(w);
    }
    for (const [id, { uk, ukAuthor }] of Object.entries(this.ukTitles)) for (const o of [...(byTitle.get(norm(uk)) || []), ...(byMain.get(norm(uk)) || [])]) if (names(o.author).some((n) => names(ukAuthor).includes(n))) link(id, o.id);
    // The original Haiku named for a reader's Ukrainian book: a work of that title by the same author.
    for (const [id, o] of this.aiOrigs()) if (o.title) for (const w of [...(byTitle.get(norm(o.title)) || []), ...(byMain.get(norm(o.title)) || [])]) if (names(w.author).some((n) => names(o.author).includes(n))) link(id, w.id);
    let pairs = [];
    try {
      pairs = readJson(path.join(SEED, "matches.json")).translations || [];
    } catch {
      /* none */
    }
    for (const [a, b] of pairs) link(this.slugs.get(a) || a, this.slugs.get(b) || b);
    for (const [a, b] of this.decisions().translations) link(a, b); // the owner's pairs from /admin/dupes
    for (const [a, b] of this.crossPairs || []) link(a, b); // same ISBN, link or words across scripts (linkEditions)
    this.linkCycles();
    this.authors = require("./authors").build(this);
  }

  // A book's place in a series, for recommendations and the book page (Max, 2026-10-23: «ніхто не почне
  // рандомно читати шосту книгу з 8»). From Wikidata (wikidata.seriesOf, meta `wikidata:series`), a Goodreads
  // title «(Dungeon Crawler Carl, #4)» kept at import (`cycle` on the book), and the numbered volumes of a
  // shop's shelf (linkSeries). A translation is in its original's series at the same place.
  linkCycles() {
    const wd = JSON.parse(this.db.get("wikidata:series") || "{}");
    this.cycles = new Map(); // work id -> { key, n }
    this.cycleInfo = new Map(); // key -> { name, uk, members: [{ n, en, uk }] } (members from Wikidata only)
    this.cycleIds = new Map(); // key -> [{ n, id }] by n
    this.aliasIdx = null;
    const set = (id, key, n) => {
      id = this.canonical(id);
      if (n > 0 && !this.cycles.has(id)) this.cycles.set(id, { key, n });
    };
    const byName = new Map();
    for (const [qid, s] of Object.entries(wd.series || {})) {
      this.cycleInfo.set(qid, s);
      for (const name of [s.name, s.uk]) if (name) byName.set(norm(name), qid);
    }
    const into = nestedSeries(wd.series || {});
    for (const [id, { qid, n }] of Object.entries(wd.books || {})) {
      const m = into.get(qid);
      set(id, m ? m.to : qid, m ? m.n.get(n) || n : n);
    }
    for (const b of Object.values(this.lib.books)) {
      if (!b.cycle?.n) continue;
      const key = byName.get(norm(b.cycle.name)) || `goodreads:${norm(b.cycle.name)}`;
      if (!this.cycleInfo.has(key)) this.cycleInfo.set(key, { name: b.cycle.name, members: [] });
      set(b.id, key, b.cycle.n);
    }
    for (const ser of new Set(this.series?.values() || [])) {
      for (const { item } of ser.items) if (!item.bundle) set(item.id, `shelf:${ser.head}`, item.volume);
      if (!this.cycleInfo.has(`shelf:${ser.head}`)) this.cycleInfo.set(`shelf:${ser.head}`, { name: ser.name, members: [] });
    }
    for (const [id, c] of [...this.cycles]) for (const t of this.translations.get(id) || []) set(t, c.key, c.n);
    for (const [id, c] of this.cycles) (this.cycleIds.get(c.key) || this.cycleIds.set(c.key, []).get(c.key)).push({ n: c.n, id });
    // Of two books at one place (an original and its translation) the Ukrainian one comes first.
    const uk = (id) => (/[а-яіїєґ]/i.test(this.lib.books[id]?.title || this.shelfItems.get(id)?.item.title || "") ? 0 : 1);
    for (const list of this.cycleIds.values()) list.sort((a, b) => a.n - b.n || uk(a.id) - uk(b.id));
  }

  // The series key of a book, or "".
  cycleKey(id) {
    return this.cycles?.get(this.canonical(id))?.key || "";
  }

  // The book to recommend in place of this one: itself unless it is a later volume of a series, then the
  // series' first book, or null when we don't have the first one (nobody starts a series at book six).
  // For a reader who has some of it (`own`, canonical ids), the first volume they don't have yet.
  seriesStart(id, own = null) {
    id = this.canonical(id);
    const c = this.cycles?.get(id);
    if (!c || (c.n === 1 && !own)) return id;
    const list = this.cycleIds.get(c.key);
    if (list[0].n !== 1) return null;
    if (!own) return list[0].id;
    const had = new Set(list.filter((x) => own.has(x.id)).map((x) => x.n));
    return list.find((x) => !had.has(x.n))?.id || null;
  }

  // A book's series in short, for a reader's shelf (pages.libraryPage folds the volumes a reader has into
  // one row): { key, name, n, total } or null. `total` counts the volumes we know of, ours or Wikidata's.
  seriesOf(id) {
    const c = this.cycles?.get(this.canonical(id));
    if (!c) return null;
    const info = this.cycleInfo.get(c.key) || { name: "", members: [] };
    const ns = new Set([...info.members.map((m) => m.n), ...this.cycleIds.get(c.key).map((x) => x.n)]);
    const cyr = !!info.uk && /[а-яіїєґ]/i.test(this.book(id)?.title || "");
    return { key: c.key, name: (cyr && info.uk) || info.name, n: c.n, total: ns.size };
  }

  // «Уся серія» on the edit page (Max, 2026-10-23: the eight volumes of Dungeon Crawler Carl read in one
  // summer are one row on the shelf, not eight): the status, rating, year and copy go on every volume of
  // the series of `id`; the note stays on the book being edited. A volume we know only from Wikidata is
  // added as the reader's own book, in the series at its place, so the shelf shows the whole set.
  // Returns the ids of the books added, for the details pass.
  markSeries(reader, id, patch) {
    const c = this.cycleOf(id);
    if (!c) return [];
    const author = this.book(id)?.author || "";
    const added = [];
    const { note, ...rest } = patch;
    const entries = this.entriesOf(reader);
    for (const v of c.items) {
      // The reader may have the volume as the original where we'd show the translation: their entry wins.
      let vid = (v.id && this.cycleIds.get(c.key).find((x) => x.n === v.n && entries[x.id])?.id) || v.id;
      if (!vid) {
        vid = this.addBook({ title: v.title, author, cover: "", links: [], cycle: { name: c.name, n: v.n } }).id;
        added.push(vid);
      }
      this.setEntry(reader, vid, this.canonical(vid) === this.canonical(id) ? patch : rest);
    }
    if (added.length) this.linkCycles();
    return added;
  }

  removeSeries(reader, id) {
    const c = this.cycleOf(id);
    for (const v of c?.items || []) if (v.id && this.entry(reader, v.id)) this.removeEntry(reader, v.id);
  }

  // For the book page: the series and every volume of it we know of, in order, with our page when we have one.
  cycleOf(id) {
    const c = this.cycles?.get(this.canonical(id));
    if (!c) return null;
    const info = this.cycleInfo.get(c.key) || { name: "", members: [] };
    const ours = new Map();
    for (const x of this.cycleIds.get(c.key)) if (!ours.has(x.n)) ours.set(x.n, x.id);
    const ns = [...new Set([...info.members.map((m) => m.n), ...ours.keys()])].sort((a, b) => a - b);
    // A volume we don't have is named in the language of the book the page is about.
    const cyr = /[а-яіїєґ]/i.test(this.book(id)?.title || "");
    const items = ns.map((n) => {
      const id = ours.get(n);
      const b = id && this.book(id);
      const m = info.members.find((x) => x.n === n);
      return { n, title: b?.title || (cyr ? m?.uk || m?.en : m?.en || m?.uk) || "", href: b?.href || "", id: b?.id || "" };
    });
    return { key: c.key, name: (cyr && info.uk) || info.name, n: c.n, items: items.filter((x) => x.title) };
  }

  // Titles of known books mentioned in a note become links (Max, 2026-10-19: «Див також Circe» ->
  // /book/tsyrtseia, whose original title is Circe). Library books by title or original title; catalog
  // books by original title, or by a title of two words or more and 12+ letters, so a common word
  // («Дім», «Free») never links. Case-sensitive, whole words; the book's own title and text already
  // inside a link are left alone.
  titleIndex() {
    if (this._titles) return this._titles;
    const map = new Map(); // title -> id, the library first
    const ok = (t, strict) => {
      t = String(t || "").trim();
      if (t.length < 4 || /^[\d\s.]+$/.test(t)) return false;
      const words = t.split(/\s+/).length;
      return strict ? words >= 2 && t.length >= 12 : words >= 2 || t.length >= 5;
    };
    const put = (t, id) => !map.has(t) && map.set(t, this.canonical(id));
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books)]) for (const t of [b.title, b.altTitle]) if (ok(t)) put(t.trim(), b.id);
    for (const { shelf, item } of this.shelfItems.values()) {
      if (shelf.draft || this.hidden.has(item.id)) continue;
      if (ok(item.altTitle)) put(item.altTitle.trim(), item.id);
      if (ok(item.title, true)) put(item.title.trim(), item.id);
    }
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titles = [...map.keys()].sort((a, b) => b.length - a.length);
    const re = titles.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${titles.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
    return (this._titles = { map, re });
  }

  // Markdown with the titles it mentions linked to their pages.
  linkTitles(md, selfId) {
    const { map, re } = this.titleIndex();
    if (!md || !re) return md || "";
    const self = selfId && this.canonical(selfId);
    // Leave existing links and bare URLs as they are.
    return md
      .split(/(\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/)
      .map((part, i) => (i % 2 ? part : part.replace(re, (t) => (map.get(t) === self ? t : `[${t}](${this.href(map.get(t))})`))))
      .join("");
  }

  // The other-language versions of a work: [{ id, title, href }].
  translationsOf(id) {
    return [...(this.translations?.get(this.canonical(id)) || [])].map((t) => this.book(t)).filter(Boolean).map((b) => ({ id: b.id, title: b.title, author: b.author, href: this.href(b.id), cover: b.cover || "" }));
  }

  // The reader's entry for a work, or, failing that, for one of its translations ({ ...entry, via }).
  sharedEntry(reader, id) {
    const own = this.entry(reader, id);
    if (own) return own;
    for (const t of this.translations?.get(this.canonical(id)) || []) {
      const e = this.entriesOf(reader)[t];
      if (e) return { ...e, via: { id: t, title: this.book(t)?.title || t, href: this.href(t) } };
    }
    return null;
  }

  // Every reader who has the work (or a translation of it): [{ reader, entry }], fullest first.
  // «Покинуто» is left out: it is the reader's own, not a word about the book to others.
  // With `all`, those too (counted, never named: social.js stats).
  readersOf(id, { all = false } = {}) {
    const out = [];
    for (const reader of this.entries.keys()) {
      const e = this.sharedEntry(reader, id);
      if (e && (all || e.status !== "abandoned")) out.push({ reader, entry: e });
    }
    return out.sort((a, b) => (b.entry.note?.length || 0) - (a.entry.note?.length || 0) || (b.entry.rating ?? -1) - (a.entry.rating ?? -1));
  }

  // Works that look like one book twice (Max, 2026-10-21: «давай ще шукати дублі»): the same author's
  // surname and the same main title (before a colon, a dot or a bracket), yet two pages. For the owner
  // to look over on /admin/dupes; pairs listed in matches.json as different are left out.
  dupes() {
    let different = [];
    try {
      different = readJson(path.join(SEED, "matches.json")).different || [];
    } catch {}
    const no = new Set([...different, ...this.decisions().different].map((p) => p.join("|")));
    // The main title is what stands before a colon or a sentence dot; a tail with a number (a volume,
    // a part, «Vol. 2») is left alone, since volumes are different books.
    const main = (t) => {
      const [head, ...tail] = String(t || "").replace(GENRE, "").replace(/\s*\([^()]*\)/g, "").split(/:|\.\s/);
      return /\d/.test(tail.join(" ")) ? "" : norm(head);
    };
    // The first author's surname: «Erik Brynjolfsson, Andrew McAfee» and «Erik Brynjolfsson» are one.
    const surname = (a) => {
      const ws = norm(String(a || "").split(/\s+and\s+|\s*[,&;]\s*/)[0]).split(" ").filter((w) => w.length >= 3);
      return ws.length ? ws[ws.length - 1] : "";
    };
    const works = [...this.seedBooks, ...Object.values(this.lib.books).filter((b) => !this.seedBooks.some((s) => s.id === b.id)), ...[...this.shelfItems.values()].filter(({ item }) => this.canonical(item.id) === item.id && !this.hidden.has(item.id)).map(({ item }) => item)];
    const groups = new Map();
    for (const w of works) {
      const t = main(w.title);
      const a = surname(w.author);
      if (!a || t.length < 4 || w.bundle || this.canonical(w.id) !== w.id) continue;
      const key = `${a}|${t}`;
      (groups.get(key) || groups.set(key, new Map()).get(key)).set(this.canonical(w.id), w);
    }
    const out = [];
    for (const g of groups.values()) {
      const ids = [...g.keys()];
      if (ids.length < 2) continue;
      // A translation pair (linked already) is one work in two languages, not a duplicate.
      if (ids.length === 2 && this.translations?.get(ids[0])?.has(ids[1])) continue;
      if (ids.length === 2 && (no.has(`${ids[0]}|${ids[1]}`) || no.has(`${ids[1]}|${ids[0]}`))) continue;
      out.push(
        ids.map((id) => {
          const b = this.book(id);
          const si = this.shelfItems.get(id);
          return { id, title: b?.title || g.get(id).title, author: b?.author || "", href: this.href(id), source: this.lib.books[id]?.source || (si ? si.shelf.name : "books.md"), readers: this.readersOf(id).length, editions: (this.editions.get(id) || []).length };
        })
      );
    }
    return out.sort((a, b) => b.reduce((n, x) => n + x.readers, 0) - a.reduce((n, x) => n + x.readers, 0));
  }

  // ---- canonical URLs ----
  // Every work has one address, /book/<slug>, built from its title (the Books.md ids already are
  // such slugs); an edition id or an old address redirects there. A slug, once given, is kept in the
  // database and stays with its work, so a new shelf never moves an existing book's address.
  indexSlugs() {
    this.slugs = new Map(); // slug -> id
    this.slugOf = new Map(); // id -> slug
    // Cyrillic slugs given before 2026-10-19 stay as old addresses that redirect to the Latin one.
    const latin = (slug) => /^[\x00-\x7f]*$/.test(slug);
    for (const r of this.db.prepare("SELECT slug, id FROM slugs").all()) {
      this.slugs.set(r.slug, r.id);
      if (!this.slugOf.has(r.id) || latin(r.slug)) this.slugOf.set(r.id, r.slug); // the newest Latin slug is the address
    }
    const add = this.db.prepare("INSERT OR IGNORE INTO slugs (slug, id) VALUES (?, ?)");
    this.db.exec("BEGIN");
    const take = (id, title, author, raw = title) => {
      const had = this.slugOf.get(id);
      // An address given from a title with an edition note («drakula-2-he-vydannia») moves to the work's
      // name when that address is free; the old one stays in the table and redirects.
      const stale = had && latin(had) && raw !== title && had.startsWith(slugify(raw)) && !this.slugs.has(slugify(title));
      if (had && latin(had) && !stale) return;
      let slug = slugify(title);
      const surname = (author || "").split(/[,\s]+/).filter(Boolean).pop();
      const last = surname ? slugify(surname) : ""; // slugify("") is "book": «tyhrolovy-book»
      if (this.slugs.has(slug) && this.slugs.get(slug) !== id && last) slug = `${slug}-${last}`;
      while (this.slugs.has(slug) && this.slugs.get(slug) !== id) slug += "-2";
      this.slugs.set(slug, id);
      this.slugOf.set(id, slug);
      add.run(slug, id);
    };
    for (const b of this.seedBooks) take(b.id, b.id, "");
    for (const b of Object.values(this.lib.books)) take(b.id, b.id, "");
    for (const { item } of this.shelfItems.values()) if (this.canonical(item.id) === item.id) take(item.id, workName(item.title) || item.title, item.author, item.title);
    // Every edition's full title keeps an address that redirects to its work: it had that address while
    // it was a work of its own, or before the work's name dropped its edition note («…-podarunkove-vydann»).
    // Until 2026-10-21 the table allowed one slug per id, so such addresses lived only in memory.
    for (const { item } of this.shelfItems.values()) {
      const own = slugify(item.title);
      if (!this.slugs.has(own)) {
        this.slugs.set(own, item.id);
        add.run(own, item.id);
      }
    }
    this.db.exec("COMMIT");
    for (const { item } of this.shelfItems.values()) item.href = this.href(item.id);
  }

  // Covers picked by hand in matches.json «covers» (Max chose Основи's «Тигролови», 2026-10-20).
  pickCovers() {
    let covers = {};
    try {
      covers = readJson(path.join(SEED, "matches.json")).covers || {};
    } catch {
      /* none */
    }
    this.covers = new Map(Object.entries(covers).map(([k, url]) => [this.canonical(this.slugs.get(k) || k), url]));
  }

  href(id) {
    id = this.canonical(id);
    return `/book/${encodeURIComponent(this.slugOf.get(id) || id)}`;
  }

  // The id behind an address: a slug, an id, or an edition id.
  resolve(param) {
    const id = this.slugs.has(param) ? this.slugs.get(param) : param;
    return this.book(id) ? this.canonical(id) : null;
  }

  // ---- search ----
  // One index over everything: the library and every shelf, works only (editions and volumes fold
  // in as extra text). FTS5 with prefix matching ranks title over author over series; when that finds
  // nothing, a trigram index catches a word typed from its middle («кирпат» in «Кирпатого»).
  // Every work once: the library and every shelf, editions folded in.
  workIds() {
    return new Set([...this.seedBooks.map((b) => b.id), ...Object.keys(this.lib.books), ...[...this.shelfItems.keys()].filter((id) => this.canonical(id) === id && !this.hidden.has(id))].filter((id) => this.canonical(id) === id));
  }

  // Haiku's genres for a work (genretrial.js, table ai_genre; Max 2026-10-23 «вогонь. на все»): they come
  // first and replace the genres guessed from shop shelves and subjects; the owner's «Основний жанр» still wins.
  aiGenres() {
    return (this.aiG ??= new Map(this.db.prepare("SELECT id, genres FROM ai_genre").all().map((r) => [r.id, JSON.parse(r.genres)])));
  }

  // Haiku's language for an edition with a Cyrillic title that settles nothing and no language from its shop
  // (langtrial.js, table ai_lang; Max 2026-10-23): book() takes it as the language, so isRussian() follows it.
  aiLangs() {
    return (this.aiL ??= new Map(this.db.prepare("SELECT id, lang FROM ai_lang").all().map((r) => [r.id, r.lang])));
  }

  setAiLang(id, lang, prompt) {
    this.db.prepare("INSERT OR REPLACE INTO ai_lang (id, lang, prompt, at) VALUES (?, ?, ?, ?)").run(id, lang, prompt, new Date().toISOString());
    this.aiLangs().set(id, lang);
  }

  // Haiku's answer to «what was this Ukrainian book translated from» (origtrial.js, table ai_orig; Max 2026-10-23):
  // { kind: translation | ukrainian | unknown, title, author, lang }. The original title pairs the book with the
  // original in linkTranslations when a catalog has it, and is named on the book page while none does.
  aiOrigs() {
    return (this.aiO ??= new Map(this.db.prepare("SELECT id, kind, title, author, lang FROM ai_orig").all().map((r) => [r.id, origShown(r)])));
  }

  setAiOrig(id, { kind, title = "", author = "", lang = "" }, prompt) {
    const r = origShown({ id, kind, title, author, lang });
    this.db.prepare("INSERT OR REPLACE INTO ai_orig (id, kind, title, author, lang, prompt, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, r.kind, r.title, r.author, r.lang, prompt, new Date().toISOString());
    this.aiOrigs().set(id, r);
  }

  // Answers of a catalog pass (aipass.js, table ai_answer) by id, cached until the pass applies again.
  aiAnswers(pass) {
    this._aiAnswers ??= {};
    return (this._aiAnswers[pass] ??= new Map(this.db.prepare("SELECT id, answer FROM ai_answer WHERE pass = ?").all(pass).map((r) => [r.id, JSON.parse(r.answer)])));
  }

  aiAnswersChanged(pass) {
    if (this._aiAnswers) delete this._aiAnswers[pass];
  }

  hiddenCovers() {
    return (this._hiddenCovers ??= JSON.parse(this.db.get("covers:hidden") || "{}"));
  }

  hideCovers(map) {
    this._hiddenCovers = { ...this.hiddenCovers(), ...map };
    this.db.set("covers:hidden", JSON.stringify(this._hiddenCovers));
  }

  setAiGenres(id, genres, prompt) {
    this.db.prepare("INSERT OR REPLACE INTO ai_genre (id, genres, prompt, at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(genres), prompt, new Date().toISOString());
    this.aiGenres().set(id, genres);
  }

  indexSearch() {
    const ids = this.workIds();
    const db = this.db;
    db.tx(() => {
      db.exec("DELETE FROM search; DELETE FROM search_tri;");
      this.vocab = null; // the typo search reloads the word list
      this.sounds = null;
      this.aliasIdx = null;
      const add = db.prepare("INSERT INTO search (id, title, alt, author, series, extra) VALUES (?, ?, ?, ?, ?, ?)");
      const tri = db.prepare("INSERT INTO search_tri (id, text) VALUES (?, ?)");
      const genres = new Map(); // our genre -> the works with it, for /genre/<slug>
      this.genreIdx = genres;
      for (const id of ids) {
        const b = this.book(id);
        if (!b) continue;
        if (!isRussian(b)) for (const g of mainGenres(b.tags)) (genres.get(g) || genres.set(g, []).get(g)).push(id);
        const uk = this.ukTitles?.[id];
        const extra = [...(b.editions || []).map((e) => [e.title, e.altTitle, e.author, e.isbn].filter(Boolean).join(" ")), uk ? `${uk.uk} ${uk.ukAuthor}` : "", ...isbnsOf(b)].join(" ");
        // The series' own name too («Dungeon Crawler Carl» finds every volume), and the owner's other names.
        const c = this.cycles?.get(id) && this.cycleInfo.get(this.cycles.get(id).key);
        const series = [...new Set([b.series?.name, c?.name, c?.uk].filter(Boolean))].join(" ");
        add.run(id, b.title || "", b.altTitle || "", [b.author, b.authorOrig].filter(Boolean).join(" "), series, [extra, b.aliases].filter(Boolean).join(" "));
        tri.run(id, [b.title, b.altTitle, b.author, b.authorOrig, series, uk?.uk].filter(Boolean).join(" · "));
      }
    });
  }

  // A typo («лялки», «легйон»): each word the index does not know is replaced by the indexed words
  // one or two letters away from it, and the search runs again.
  fuzzy(terms, limit) {
    this.vocab ??= this.db.prepare("SELECT term FROM search_vocab").all().map((r) => r.term);
    const alts = terms.map((t) => {
      if (this.vocab.some((w) => w.startsWith(t))) return [t];
      const max = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
      return this.vocab.filter((w) => Math.abs(w.length - t.length) <= max && editDistance(t, w, max) <= max).slice(0, 8);
    });
    if (alts.some((a) => !a.length)) return [];
    const match = alts.map((a) => `(${a.map((w) => `"${w}"*`).join(" OR ")})`).join(" AND ");
    return this.db.prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 10, 10, 5, 4, 1) LIMIT ?").all(match, limit * 2);
  }

  // Latin words of the index that sound like a Cyrillic word: «міллер» → miller, «оруелл» → orwell.
  // Typing the start of a name finds it too («мураk…» once it is 4 letters or more). A Latin word, or one
  // shorter than 3 letters, has none.
  latinAlts(term) {
    if (!/[а-яіїєґ]/.test(term) || term.length < 3) return [];
    if (this.altCache?.has(term)) return this.altCache.get(term);
    if (!this.sounds) {
      this.altCache = new Map(); // term -> words: the author and reader lists ask once per name
      this.vocab ??= this.db.prepare("SELECT term FROM search_vocab").all().map((r) => r.term);
      this.sounds = new Map(); // sound -> [latin words]
      for (const w of this.vocab) if (/^[a-z]{3,}$/.test(w)) (this.sounds.get(soundOf(w)) || this.sounds.set(soundOf(w), []).get(soundOf(w))).push(w);
    }
    const k = soundOf(term);
    const max = k.length >= 7 ? 2 : k.length >= 4 ? 1 : 0;
    const exact = [], near = [], start = [];
    for (const [s, words] of this.sounds) {
      if (s === k) exact.push(...words);
      else if (k.length >= 4 && s.startsWith(k)) start.push(...words);
      else if (max && Math.abs(s.length - k.length) <= max && editDistance(k, s, max) <= max) near.push(...words);
    }
    const out = [...exact, ...near, ...start].slice(0, 12);
    if (this.altCache.size > 1000) this.altCache.clear();
    this.altCache.set(term, out);
    return out;
  }

  // Short names readers type for a series, a book or an author (Max, 2026-10-23: «DCC» found nothing).
  // seed/aliases.json maps a short name to what to search instead («гп» → «Гаррі Поттер»); the owner's
  // «Інші назви» on /admin/book/:id point at one book; and the first letters of a series' name or of the title
  // of a book on readers' shelves point at those books, when no more than three names share them.
  searchAliases() {
    // Rebuilt after a reindex, and every ten minutes for the titles readers have just shelved.
    if (this.aliasIdx && Date.now() - this.aliasIdx.at < 600e3) return this.aliasIdx;
    let seed = {};
    try {
      seed = readJson(path.join(SEED, "aliases.json")).aliases || {};
    } catch {
      /* none */
    }
    const query = new Map(Object.entries(seed).map(([k, v]) => [aliasKey(k), v]));
    const own = new Map(); // key -> [ids]
    for (const [id, fix] of Object.entries(this.edits())) for (const a of String(fix.aliases || "").split(/[,;]/)) if (aliasKey(a)) (own.get(aliasKey(a)) || own.set(aliasKey(a), []).get(aliasKey(a))).push(this.canonical(id));
    const auto = new Map(); // key -> Map(name -> [ids])
    const put = (name, ids) => {
      for (const k of acronyms(name)) {
        const m = auto.get(k) || auto.set(k, new Map()).get(k);
        m.set(norm(name), [...(m.get(norm(name)) || []), ...ids]);
      }
    };
    for (const [key, list] of this.cycleIds || []) {
      const info = this.cycleInfo.get(key) || {};
      for (const name of new Set([info.name, info.uk].filter(Boolean))) put(name, list.map((x) => x.id));
    }
    const shelved = new Set([...this.entries.values()].flatMap((e) => Object.keys(e)).map((i) => this.canonical(i)));
    // The title without building the whole book: a few thousand of them every ten minutes.
    const seedTitle = new Map(this.seedBooks.map((b) => [b.id, b.title]));
    for (const id of shelved) put(this.edits()[id]?.title || this.lib.books[id]?.title || this.shelfItems.get(id)?.item.title || seedTitle.get(id), [id]);
    const acr = new Map();
    for (const [k, names] of auto) if (names.size <= 3) acr.set(k, [...new Set([...names.values()].flat())]);
    return (this.aliasIdx = { query, own, acr, at: Date.now() });
  }
  aliasQuery(q) {
    return this.searchAliases().query.get(aliasKey(q)) || "";
  }

  search(q, { reader = null, limit = 40, alias = true } = {}) {
    const terms = norm(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    if (alias) {
      // A short name: its books go first (after a book of that very title), then what the words find.
      const { own, acr } = this.searchAliases();
      const key = aliasKey(q);
      const to = this.aliasQuery(q);
      const mine = own.get(key) || [];
      const guessed = key.length >= 3 ? acr.get(key) || [] : [];
      if (to || mine.length || guessed.length) {
        const out = this.search(q, { reader, limit, alias: false });
        const byId = new Map(out.map((h) => [h.book.id, h]));
        // Named by hand: above the books whose words match. Guessed from first letters: just below them.
        let n = 0;
        const add = (b, top) => {
          if (!b || isRussian(b)) return;
          const score = (top ? 900 : 450) - n++;
          const h = byId.get(b.id);
          if (h) h.score = Math.max(h.score, score);
          else byId.set(b.id, { book: b, entry: reader ? this.sharedEntry(reader, b.id) : null, score });
        };
        for (const h of to ? this.search(to, { reader, limit, alias: false }) : []) add(h.book, true);
        for (const id of mine) add(this.book(id), true);
        for (const id of guessed) add(this.book(id), false);
        return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
      }
    }
    let rows = this.db
      .prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 10, 10, 5, 4, 1) LIMIT ?")
      .all(terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" "), limit * 2);
    // A Latin name typed in Cyrillic («міллер», «мураками»): the same search with the words that sound like
    // it, after what the Cyrillic itself found (Max, 2026-10-22).
    const alts = terms.map((t) => this.latinAlts(t));
    if (alts.some((a) => a.length)) {
      const seen = new Set(rows.map((r) => r.id));
      const match = terms.map((t, i) => `("${t.replace(/"/g, "")}"*${alts[i].map((w) => ` OR "${w}"`).join("")})`).join(" AND ");
      rows = [...rows, ...this.db.prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 10, 10, 5, 4, 1) LIMIT ?").all(match, limit * 2).filter((r) => !seen.has(r.id))];
    }
    if (!rows.length && terms.every((t) => t.length >= 3)) rows = this.db.prepare("SELECT id FROM search_tri WHERE search_tri MATCH ? ORDER BY rank LIMIT ?").all(terms.map((t) => `"${t}"`).join(" AND "), limit * 2);
    if (!rows.length) rows = this.fuzzy(terms, limit);
    const exact = norm(q);
    const hits = [];
    for (const [i, { id }] of rows.entries()) {
      const b = this.book(id);
      if (!b || isRussian(b)) continue;
      // An exact title (or original title) goes first, then books where every typed word is a whole
      // word of the title or the author («Лем» is Станіслав Лем, not «Моцарт із Лемберга»; «міллер» is
      // Madeline Miller); otherwise the index's own order.
      const words = new Set(norm([b.title, b.altTitle, b.author].join(" ")).normalize("NFKD").replace(/\p{M}/gu, "").split(" "));
      const whole = terms.every((t, j) => words.has(t) || alts[j].some((w) => words.has(w)));
      const score = (norm(b.title) === exact || norm(b.altTitle) === exact ? 1000 : 0) + (whole ? 500 : 0) - i;
      hits.push({ book: b, entry: reader ? this.sharedEntry(reader, id) : null, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---- works and editions ----
  // One book can sit on a shelf several times (paper and limited edition, three languages) and in the
  // library under its own id. Those are editions of one work: every edition id is aliased to one
  // canonical id (the library book when there is one, else one shelf item), the library keys its
  // entries by the canonical id, and book pages list all editions with their buy links.
  linkEditions() {
    this.aliases = new Map(); // edition id -> canonical id
    this.editions = new Map(); // canonical id -> [{ shelf, item }]
    this.hidden = new Set(); // shelf items that are a second edition of another item on the same shelf
    // and shop items that are not books (catalogpasses.js notbooks: sticker books, colouring books, postcards)
    for (const [id, a] of this.aiAnswers("notbooks")) if (a.kind === "not_book") this.hidden.add(id);
    let matches = { same: {}, different: [] };
    try {
      matches = readJson(path.join(SEED, "matches.json"));
    } catch {
      /* no hand-confirmed matches */
    }
    const decided = this.decisions();
    const no = new Set([...matches.different, ...decided.different].map((p) => p.join("|")));

    // 1. Shelf items that share an ISBN or an author+title are one work.
    const groups = new Map(); // key -> group (array of {shelf,item})
    const groupOf = new Map(); // item id -> group
    const join = (key, si) => {
      const g = groupOf.get(si.item.id);
      const other = groups.get(key);
      if (other && g && other !== g) {
        for (const m of g) (other.push(m), groupOf.set(m.item.id, other));
      } else if (other && !g) (other.push(si), groupOf.set(si.item.id, other));
      else if (!other && g) groups.set(key, g);
      else {
        const ng = [si];
        groups.set(key, ng);
        groupOf.set(si.item.id, ng);
      }
    };
    // A shared ISBN counts only with the same title: publishers' sites reuse ISBNs by mistake.
    // (Основи gives a bundle the ISBN of one of its books, so a bundle never joins a single book this way.)
    const alike = (a, b) => !a.bundle === !b.bundle && (norm(a.title).startsWith(norm(b.title)) || norm(b.title).startsWith(norm(a.title)));
    // The title for that compares as the work's name (workName): Старий Лев sells «Тигролови (м'яка
    // обкладинка)» and «Тигролови (в-во Віхола)» next to «Тигролови», and «Колгосп тварин: Казка» is «Колгосп тварин».
    const workTitle = (t) => norm(workName(t));
    const titled = new Map(); // work title -> Set of authors, for the items that have none
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      const ik = `isbn:${isbnKey(it.isbn)}`;
      if (isbnKey(it.isbn).length >= 10 && (!groups.has(ik) || alike(groups.get(ik)[0].item, it))) join(ik, si);
      if (workTitle(it.title) && norm(it.author)) {
        join(`at:${norm(it.author)}|${workTitle(it.title)}`, si);
        (titled.get(workTitle(it.title)) || titled.set(workTitle(it.title), new Set()).get(workTitle(it.title))).add(norm(it.author));
      }
      if (!groupOf.has(it.id)) groupOf.set(it.id, [si]);
    }
    // A shop that gives no author (MEGOGO Books' Stone «Тигролови») joins the work of that title when
    // only one author has a book called so. Short titles («Дім») are too common to trust.
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      const t = workTitle(it.title);
      if (norm(it.author) || t.length < 6 || titled.get(t)?.size !== 1) continue;
      join(`at:${[...titled.get(t)][0]}|${t}`, si);
    }
    // An audiobook's title often keeps the subtitle the print edition drops, or the other way round
    // («Атомні звички. Легкий і перевірений спосіб…»): with the same author, one title starting with the
    // other joins them, when the shorter one has at least two words (one word, «Дюна», is too little).
    const byAuthor = new Map(); // author -> print and e-book items
    for (const si of this.shelfItems.values()) {
      const a = norm(si.item.author);
      if (a && si.item.format !== "аудіо" && !si.item.bundle) (byAuthor.get(a) || byAuthor.set(a, []).get(a)).push(si);
    }
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      if (it.format !== "аудіо" || groupOf.get(it.id).length > 1) continue;
      const short = (o) => (norm(o.title).length < norm(it.title).length ? norm(o.title) : norm(it.title));
      const other = (byAuthor.get(norm(it.author)) || []).find((o) => (o.item.volume || 0) === (it.volume || 0) && alike(o.item, it) && short(o.item).includes(" "));
      if (other) join(`at:${norm(other.item.author)}|${workTitle(other.item.title)}`, si);
    }

    // 2. A shelf item whose title (or original title) is exactly a library book's title is that book.
    // Failing that, the library book links to the item's own page, or has the same words in its main
    // title, in any order, by the same author («Я кров твою змішаю з вугіллям» is Старий Лев's
    // «Я змішаю твою кров із вугіллям: зрозуміти український Схід»).
    const byTitle = new Map(); // normalized title -> [{ id, author }], exact titles first, then titles without the author's name
    const byUrl = new Map();
    const byWords = new Map();
    const byIsbn = new Map(); // a library book's ISBN (a Goodreads import keeps it; Books.md links to Amazon by ISBN-10)
    const pageKey = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const words = (t) => norm(String(t || "").split(/[:.(]/)[0]).split(" ").filter((w) => w.length >= 3).sort().join(" ");
    const names = (a) => norm(a).split(" ").filter((w) => w.length >= 3);
    // Books.md often adds the author to the title («Моя війна Залужний», «Genome, Matt Ridley», «Жадан
    // Арабески»): the title without the author's names at either end counts too.
    const bare = (t, author) => {
      const ws = norm(t).split(" ");
      const a = new Set(norm(author).split(" ").filter((w) => w.length >= 3));
      while (ws.length > 1 && a.has(ws[ws.length - 1])) ws.pop();
      while (ws.length > 1 && a.has(ws[0])) ws.shift();
      return ws.join(" ");
    };
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books).filter((b) => !this.seedBooks.some((s) => s.id === b.id))]) {
      const own = this.lib.books[b.id] || b; // an edited copy keeps its old title
      const addTitle = (t, exact) => {
        const l = byTitle.get(t) || byTitle.set(t, []).get(t);
        if (!l.some((x) => x.id === b.id)) l.push({ id: b.id, author: b.author || "", title: b.title, exact });
      };
      for (const t of [b.title, b.altTitle]) if (norm(t).length >= 6) addTitle(norm(t), true);
      for (const t of [own.title, b.title]) if (norm(bare(t, b.author)).length >= 6) addTitle(bare(t, b.author), false);
      for (const l of b.links || []) if (pageKey(l.url).includes("/")) byUrl.set(pageKey(l.url), b.id);
      for (const i of isbnsOf(own)) byIsbn.set(i, b.id);
      for (const t of [b.title, b.altTitle]) if (words(t).includes(" ")) (byWords.get(words(t)) || byWords.set(words(t), []).get(words(t))).push(b);
    }
    const script = (t) => (/[а-яіїєґ]/i.test(t) ? "cyr" : "lat");
    this.crossPairs = [];
    const bookOf = (it) => {
      if (matches.same[it.id]) return matches.same[it.id];
      const ok = (id) => id && !no.has(`${it.id}|${id}`);
      // A book titled in the other script is a translation, whatever else matches (an ISBN, a link, the
      // words): Старий Лев's «Під скляним ковпаком» is not an edition of a reader's «The Bell Jar» (Max, 2026-10-23).
      // Such a pair is linked as a translation instead (linkTranslations).
      const same = (id) => {
        if (!ok(id)) return false;
        if (script((this.lib.books[id] || this.seedBooks.find((b) => b.id === id))?.title || "") === script(it.title)) return true;
        this.crossPairs.push([id, it.id]);
        return false;
      };
      if (isbnKey(it.isbn).length >= 10 && same(byIsbn.get(isbnKey(it.isbn)))) return byIsbn.get(isbnKey(it.isbn));
      // The same title by a different author is a different book: Жадан's «Арабески» is not Хвильовий's
      // (2026-10-22). An exact title wins over one with the author's name trimmed off («Жадан Арабески»).
      // A match through an original title («Марсіанин» / The Martian, «Чотири тисячі тижнів» / Four
      // Thousand Weeks) is a translation, not an edition: the two stay separate pages with shared readers
      // (Max, 2026-10-21/22), and linkTranslations pairs them. So two books merge only when their own
      // titles are written in the same script.
      for (const t of [it.title, it.altTitle]) {
        const found = (byTitle.get(norm(t)) || []).filter((x) => ok(x.id) && sameAuthor(x.author, it.author) && script(x.title) === script(it.title));
        const b = found.find((x) => x.exact) || found[0];
        if (b) return b.id;
      }
      // A shop that puts the series first («Нові Темні Віки. Колонія», Абук) sells the reader's «Колонія»:
      // the part after the series, as an exact title by the same author (Max, 2026-10-23: no covers on Кідрук).
      const tail = /^[^.:]{3,}[.:]\s+(.{3,})$/.exec(String(it.title || ""))?.[1];
      if (tail) {
        const b = (byTitle.get(norm(tail)) || []).find((x) => x.exact && ok(x.id) && sameAuthor(x.author, it.author) && script(x.title) === script(tail));
        if (b) return b.id;
      }
      if (same(byUrl.get(pageKey(it.url)))) return byUrl.get(pageKey(it.url));
      for (const t of [it.title, it.altTitle]) {
        const b = (byWords.get(words(t)) || []).find((b) => names(b.author).some((n) => names(it.author).includes(n)));
        if (b && same(b.id)) return b.id;
      }
      return null;
    };

    const seen = new Set();
    for (const g of new Set(groupOf.values())) {
      const sorted = [...g].sort((a, b) => (a.item.edition ? 1 : 0) - (b.item.edition ? 1 : 0) || FMT(a.item.format) - FMT(b.item.format) || (PICK[a.item.status] ?? 9) - (PICK[b.item.status] ?? 9) || a.item.id.localeCompare(b.item.id, "en", { numeric: true }));
      const canonical = g.map((si) => bookOf(si.item)).find(Boolean) || sorted[0].item.id;
      this.editions.set(canonical, sorted);
      const perShelf = new Set();
      for (const si of sorted) {
        if (si.item.id !== canonical) this.aliases.set(si.item.id, canonical);
        if (perShelf.has(si.shelf.id)) this.hidden.add(si.item.id);
        perShelf.add(si.shelf.id);
        si.item.editions = g.length; // for the cards
      }
      seen.add(canonical);
    }
    // 3. What the owner decided on /admin/dupes: [keep, dup] pairs; dup and everything folded into it
    // become editions of keep, whichever kind of work each is (a shelf item or a library book).
    for (const [keep, dup] of decided.same) {
      const k = this.canonical(keep);
      const d = this.canonical(dup);
      if (k === d || !this.isWork(k) || !this.isWork(d)) continue;
      for (const [alias, c] of this.aliases) if (c === d) this.aliases.set(alias, k);
      this.aliases.set(d, k);
      const eds = [...(this.editions.get(k) || []), ...(this.editions.get(d) || [])];
      const dsi = this.shelfItems.get(d);
      if (dsi && !eds.includes(dsi)) eds.push(dsi);
      const ksi = this.shelfItems.get(k);
      if (ksi && !eds.includes(ksi)) eds.unshift(ksi);
      if (eds.length) this.editions.set(k, eds);
      this.editions.delete(d);
    }
    this.linkSeries(matches.volumes || {});
  }

  // Is this id a work we know: a library book or a shelf item?
  isWork(id) {
    return !!(this.lib.books[id] || this.seedBooks.some((b) => b.id === id) || this.shelfItems.has(id));
  }

  // ---- the owner's decisions on look-alikes (/admin/dupes), kept in meta `merges` ----
  decisions() {
    try {
      const d = JSON.parse(this.db.get("merges") || "{}");
      return { same: Array.isArray(d.same) ? d.same : [], different: Array.isArray(d.different) ? d.different : [], translations: Array.isArray(d.translations) ? d.translations : [] };
    } catch {
      return { same: [], different: [], translations: [] };
    }
  }
  // A translation and its original (Max, 2026-10-21: «як доєднати укр переклад до оригіналу»): reading
  // one counts for the other, as with the pairs in matches.json.
  decideTranslation(a, b) {
    const d = this.decisions();
    a = this.workId(a);
    b = this.workId(b);
    if (!a || !b || a === b || !this.isWork(a) || !this.isWork(b)) return false;
    if (!d.translations.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) d.translations.push([a, b]);
    this.saveDecisions(d);
    return true;
  }
  // Authors with both foreign-titled and Cyrillic-titled books not yet linked as translations: the owner
  // picks the original for each translation on /admin/dupes.
  translationCandidates() {
    const latin = (t) => /[a-z]/i.test(t) && !/[а-яіїєґ]/i.test(t);
    const cyr = (t) => /[а-яіїєґ]/i.test(t);
    const out = [];
    for (const a of this.authors?.list || []) {
      const books = a.ids.map((id) => this.book(id)).filter(Boolean);
      const linked = (b, side) => side.some((o) => this.translations.get(b.id)?.has(o.id));
      const foreign = books.filter((b) => latin(b.title));
      const uk = books.filter((b) => cyr(b.title));
      if (!foreign.length || !uk.length) continue;
      const open = uk.filter((b) => !linked(b, foreign));
      if (!open.length) continue;
      const row = (b) => ({ id: b.id, title: b.title, href: b.href, readers: this.readersOf(b.id).length });
      out.push({ author: { name: a.name, href: a.href }, foreign: foreign.map(row), uk: open.map(row) });
    }
    return out.sort((x, y) => y.uk.reduce((n, b) => n + b.readers, 0) + y.foreign.reduce((n, b) => n + b.readers, 0) - x.uk.reduce((n, b) => n + b.readers, 0) - x.foreign.reduce((n, b) => n + b.readers, 0));
  }
  // For the owner on an author's page (Max, 2026-10-21: «кнопка "Позначити як переклад"»): the author's
  // foreign-titled books to pick an original from, and for each work the original it is linked to,
  // with the index of that decision when the owner made it (so it can be undone).
  translationPairing(author) {
    const latin = (t) => /[a-z]/i.test(t) && !/[а-яіїєґ]/i.test(t);
    const books = author.ids.map((id) => this.book(id)).filter(Boolean);
    const foreign = books.filter((b) => latin(b.title)).map((b) => ({ id: b.id, title: b.title }));
    const decided = this.decisions().translations;
    const linked = {};
    for (const b of books) {
      const o = foreign.find((f) => f.id !== b.id && this.translations.get(b.id)?.has(f.id));
      if (!o) continue;
      const i = decided.findIndex(([x, y]) => (x === b.id && y === o.id) || (x === o.id && y === b.id));
      linked[b.id] = { ...o, index: i >= 0 ? i : null };
    }
    return { foreign, linked };
  }
  // decide(ids, keep): every id in ids becomes an edition of keep; decide(ids, null): they are different books.
  // An id or a /book/<slug> address, as the owner may paste either.
  workId(x) {
    x = String(x || "").trim().replace(/^.*\/book\//, "").replace(/[?#].*$/, "");
    return this.canonical(this.slugs?.get(x) || x);
  }
  decide(ids, keep) {
    const d = this.decisions();
    ids = [...new Set(ids.map((id) => this.workId(id)))];
    if (keep) {
      keep = this.workId(keep);
      for (const id of ids) if (id !== keep && !d.same.some(([k, x]) => k === keep && x === id)) d.same.push([keep, id]);
    } else {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!d.different.some(([a, b]) => (a === ids[i] && b === ids[j]) || (a === ids[j] && b === ids[i]))) d.different.push([ids[i], ids[j]]);
    }
    this.saveDecisions(d);
  }
  // Many «same» decisions at once ([[ids, keep]]), with one rebuild at the end (catalogpasses.js dupes).
  decideMany(groups) {
    const d = this.decisions();
    for (const [ids, keep] of groups) {
      const k = this.workId(keep);
      for (const id of new Set(ids.map((i) => this.workId(i)))) if (id !== k && !d.same.some(([a, x]) => a === k && x === id)) d.same.push([k, id]);
    }
    this.saveDecisions(d);
  }
  undecide(kind, index) {
    const d = this.decisions();
    if (d[kind]) d[kind].splice(index, 1);
    this.saveDecisions(d);
  }
  saveDecisions(d) {
    this.db.set("merges", JSON.stringify(d));
    this.linkEditions();
    this.migrateEntries();
    this.linkTranslations();
    this._works = null;
    this.indexSearch();
  }

  // ---- series ----
  // Numbered volumes of one series on a shelf («Коли завмирає серце, том перший» … шостий, plus the
  // bundle) fold into one card: the bundle when the shelf sells one, else volume one. Each volume keeps
  // its own page; every page of the series lists all volumes. Volume numbers come from the titles,
  // or from matches.json when the titles carry none (Lobster's «Бобів усесвіт»).
  linkSeries(volumes = {}) {
    this.series = new Map(); // item id -> { name, items: [{ shelf, item }] }
    const groups = new Map();
    const { volumeOf } = require("./catalogs");
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      // An item read before the title pattern knew a numbering (Богдан's «Експансія. Кн. 3») gets it here.
      const v = !it.series && !it.bundle && volumeOf(it.title);
      if (v) (it.series = v.series), (it.volume = v.volume);
      if (!it.series) continue;
      if (volumes[it.id]) it.volume = volumes[it.id];
      const key = `${si.shelf.id}|${norm(it.series)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(si);
    }
    // «Хроніки Амбера. П’ятикнижжя Корвіна. Том 1» and «…Мерліна. Том 2» are one series on the shelf, «Хроніки Амбера».
    const kin = new Map(); // shelf|parent name -> keys of single-item groups whose series is «parent. …»
    for (const [key, g] of groups) {
      const series = g[0].item.series;
      if (g.length > 1 || !series.includes(". ")) continue;
      const parent = `${key.slice(0, key.indexOf("|"))}|${norm(series.slice(0, series.lastIndexOf(". ")))}`;
      if (!kin.has(parent)) kin.set(parent, []);
      kin.get(parent).push(key);
    }
    for (const [parent, keys] of kin) {
      const all = [...(groups.get(parent) || []), ...keys.flatMap((k) => groups.get(k))];
      if (all.length < 2) continue;
      const name = groups.get(parent)?.[0].item.series || all.at(-1).item.series.slice(0, all.at(-1).item.series.lastIndexOf(". "));
      for (const k of keys) groups.delete(k);
      for (const si of all) si.item.series = name;
      groups.set(parent, all);
    }
    for (const g of groups.values()) {
      if (g.length < 2 || !g.some((si) => si.item.volume || si.item.bundle)) continue; // a label like «Шеклі» is not a series
      const sorted = [...g].sort((a, b) => (a.item.bundle ? 1 : 0) - (b.item.bundle ? 1 : 0) || (a.item.volume || 99) - (b.item.volume || 99) || a.item.id.localeCompare(b.item.id, "en", { numeric: true }));
      // Богдан sells each of «Хроніки Амбера : у 10 кн.» in three printings: the list shows one of each, in stock first.
      const one = new Map();
      for (const si of sorted) {
        const k = norm(si.item.title);
        if (!one.has(k) || (PICK[si.item.status] ?? 9) < (PICK[one.get(k).item.status] ?? 9)) one.set(k, si);
      }
      const items = sorted.filter((si) => one.get(norm(si.item.title)) === si);
      const head = g.find((si) => si.item.bundle) || items[0];
      const singles = items.filter((si) => !si.item.bundle);
      const numbered = new Set(singles.map((si) => si.item.volume).filter(Boolean));
      const ser = { name: head.item.series, head: head.item.id, items, volumes: numbered.size === singles.length || !numbered.size ? singles.length : Math.max(numbered.size, ...numbered) };
      for (const si of sorted) {
        this.series.set(si.item.id, ser);
        si.item.volumes = ser.volumes;
        if (si !== head) this.hidden.add(si.item.id);
      }
    }
  }

  // The works of one of our genres (built with the search index), and the genre a /genre/<slug> names.
  genreBooks(g) {
    return this.genreIdx?.get(g) || [];
  }
  genreBySlug(slug) {
    return [...OUR_GENRES].find((g) => slugify(g) === slug) || "";
  }

  canonical(id) {
    return this.aliases.get(id) || id;
  }

  // Shelf items worth a card: one per work per shelf.
  visible(shelf) {
    return shelf.items.filter((it) => !this.hidden.has(it.id));
  }

  load() {
    const db = this.db;
    this.lib = { books: {} };
    this.entries = new Map(); // reader id -> { book id -> entry }
    this.subs = new Map(); // reader id -> [shelf id]
    for (const r of db.prepare("SELECT id, data FROM books").all()) this.lib.books[r.id] = JSON.parse(r.data);
    for (const r of db.prepare("SELECT * FROM entries").all()) this.entriesOf(r.reader)[r.book] = { status: r.status, year: r.year, rating: r.rating, note: r.note, copy: r.copy, order: r.ord, ...(r.added ? { added: r.added } : {}), ...(r.updated ? { updated: r.updated } : {}), ...(r.kids ? { kids: true } : {}) };
    for (const r of db.prepare("SELECT reader, shelf FROM subscriptions").all()) this.subscriptions(r.reader).push(r.shelf);
  }

  // A reader's entries (made on first touch) and subscriptions.
  entriesOf(reader) {
    if (!this.entries.has(reader)) this.entries.set(reader, {});
    return this.entries.get(reader);
  }
  subscriptions(reader) {
    if (!this.subs.has(reader)) this.subs.set(reader, []);
    return this.subs.get(reader);
  }
  // A reader who is gone (deleted account): their rows are already deleted by auth.js.
  forgetReader(reader) {
    this.entries.delete(reader);
    this.subs.delete(reader);
  }

  writeEntry(reader, id, e) {
    if (!e) return this.db.prepare("DELETE FROM entries WHERE reader = ? AND book = ?").run(reader, id);
    this.db
      .prepare("INSERT INTO entries (reader, book, status, rating, year, note, copy, ord, added, updated, kids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reader, book) DO UPDATE SET status = excluded.status, rating = excluded.rating, year = excluded.year, note = excluded.note, copy = excluded.copy, ord = excluded.ord, added = excluded.added, updated = excluded.updated, kids = excluded.kids")
      .run(reader, id, e.status || "", e.rating ?? null, e.year ?? null, e.note || "", e.copy || "", e.order ?? null, e.added || null, e.updated || null, e.kids ? 1 : 0);
  }

  writeBook(id) {
    const b = this.lib.books[id];
    if (b) this.db.prepare("INSERT OR REPLACE INTO books (id, data) VALUES (?, ?)").run(id, JSON.stringify(b));
    else this.db.prepare("DELETE FROM books WHERE id = ?").run(id);
  }

  // Entries saved under an edition id (before editions were linked, or by a shelf that changed) move to the work.
  migrateEntries() {
    for (const [reader, entries] of this.entries) {
      for (const [id, e] of Object.entries(entries)) {
        const c = this.canonical(id);
        if (c === id) continue;
        const cur = entries[c];
        entries[c] = cur ? mergeEntries(cur, e) : e;
        delete entries[id];
        this.db.tx(() => (this.writeEntry(reader, c, entries[c]), this.writeEntry(reader, id, null)));
      }
    }
  }

  // Re-home readers' entries from one work to another (after a mis-merge split two books apart, the
  // entries that migrated onto the wrong one stay there). readers: user ids, or every reader when empty.
  moveEntries(from, to, readers = []) {
    const a = this.canonical(from);
    const b = this.canonical(to);
    if (a === b || !this.isWork(a) || !this.isWork(b)) return 0;
    let n = 0;
    for (const [reader, entries] of this.entries) {
      if (readers.length && !readers.includes(reader)) continue;
      const e = entries[a];
      if (!e) continue;
      entries[b] = entries[b] ? mergeEntries(entries[b], e) : e;
      delete entries[a];
      this.db.tx(() => (this.writeEntry(reader, b, entries[b]), this.writeEntry(reader, a, null)));
      n++;
    }
    return n;
  }

  seed() {
    const max = readJson(path.join(SEED, "max.json"));
    const lib = { name: max.name, books: {}, entries: {}, subscriptions: [], seeded: new Date().toISOString() };
    for (const e of max.entries) lib.entries[e.book] = { status: "read", year: e.year, rating: e.rating, note: e.noteMd || e.note, copy: "", order: e.order };
    // Paper books in the office: known ones get "paper", the rest are added as books without a status.
    let office = [];
    try {
      office = readJson(path.join(SEED, "office.json"));
    } catch {
      /* no office list */
    }
    const idx = new Map();
    for (const b of this.seedBooks) {
      idx.set(norm(b.title), b.id);
      if (b.altTitle) idx.set(norm(b.altTitle), b.id);
    }
    let order = max.entries.length;
    for (const o of office) {
      if (RU.test(o.title) || RU.test(o.author)) continue;
      const n = norm(o.title);
      let id = OFFICE_MATCHES[o.n] || idx.get(n);
      if (!id) for (const [k, v] of idx) if (k.length > 6 && (n.startsWith(k) || k.startsWith(n))) { id = v; break; }
      if (id) {
        lib.entries[id] ??= { status: "", year: null, rating: null, note: "", copy: "", order: order++ };
        lib.entries[id].copy = "paper";
      } else {
        id = slugify(o.title);
        while (lib.books[id] || this.seedBooks.some((b) => b.id === id)) id += "-2";
        lib.books[id] = { id, title: o.title, author: o.author, cover: "", tags: [], links: [], source: "office" };
        lib.entries[id] = { status: "", year: null, rating: null, note: "", copy: "paper", order: order++ };
      }
    }
    return lib;
  }

  // ---- books ----

  book(id, { edited = true } = {}) {
    id = this.canonical(id);
    const own = this.lib.books[id];
    const seed = own || this.seedBooks.find((b) => b.id === id);
    const si = seed ? null : this.shelfItems.get(id);
    const b = seed || (si && this.fromShelfItem(si.shelf, si.item));
    if (!b) return null;
    const eds = this.editions.get(id);
    const ser = [id, ...(eds || []).map((e) => e.item.id)].map((i) => this.series.get(i)).find(Boolean);
    const out = eds ? { ...b, editions: eds.map(({ shelf, item }) => ({ ...this.fromShelfItem(shelf, item), shelf })) } : { ...b };
    // A shop's edition note is not the book's name (Max, 2026-10-21: «як мені прибрати "Подарункове видання"»);
    // the «Де взяти» rows keep it, so the reader can tell the editions apart.
    if (si && workName(b.title)) out.title = workName(b.title);
    // A Books.md title that carries the author's name («Жадан Арабески», «Genome, Matt Ridley») takes the
    // name a shop gives the same book, once an edition with that name is linked.
    if (seed && eds) {
      const a = new Set(norm(b.author).split(" ").filter((w) => w.length >= 3));
      const ws = norm(b.title).split(" ").filter((w) => !a.has(w));
      if (ws.length && ws.length < norm(b.title).split(" ").length) {
        const e = eds.find(({ item }) => norm(item.title) === ws.join(" "));
        if (e) out.title = e.item.title;
      }
    }
    if (ser) out.series = { name: ser.name, head: ser.head, volumes: ser.volumes, items: ser.items.map(({ shelf, item }) => ({ ...this.fromShelfItem(shelf, item), shelf, work: this.canonical(item.id), href: this.href(item.id) })) };
    out.tags = this.genresOf(id, b, eds);
    const lang = !out.language && this.aiLangs().get(id);
    // Only to hide: a «uk» answer leaves the word guesses as they are, since Haiku called a few Russian
    // titles Ukrainian («День бульдозериста», trial v2), and a Russian book shown is worse than one hidden.
    if (lang === "ru") out.language = lang;
    const ai = edited && this.aiGenres().get(id);
    if (ai?.length) out.tags = [...ai, ...out.tags.filter((t) => !OUR_GENRES.has(t))];
    // A year before 1800 on a reader's book is Open Library's or an import's noise far more often than a real
    // date («Lolita» 1777, Max 2026-10-23); the owner can still set one in «Редагувати».
    if (Number(out.published) < 1800) delete out.published;
    // The year Haiku gives for the work's first publication, where we have none (catalogpasses.js year).
    if (!out.published && edited) {
      const y = this.aiAnswers("year").get(id);
      if (y?.known === "yes" && y.year > 0) out.published = y.year;
    }
    if (this.covers?.has(id)) out.cover = this.covers.get(id);
    // A book a reader added by hand or imported has no cover; its catalog editions do («Сила інтровертів»).
    else if (!out.cover) out.cover = (out.editions || []).find((e) => e.cover)?.cover || "";
    // A cover Haiku judged a bad scan, a blank binding or another book (catalogpasses.js covers) is not shown,
    // as long as it is still that picture; a placeholder looks better.
    if (out.cover && this.hiddenCovers()[id] === out.cover) out.cover = (out.editions || []).find((e) => e.cover && e.cover !== out.cover)?.cover || "";
    // A title cut short by an import keeps a dangling separator («Diary of Samuel Pepys -», Max 2026-10-23).
    out.title = String(out.title || "").replace(DANGLING, "") || out.title;
    // The owner's hand edits (/admin/book/:id) win over the catalogs and outlive their refreshes.
    const fix = edited && this.edits()[id];
    if (fix) {
      for (const k of EDITABLE) if (fix[k]) out[k] = fix[k];
      if (fix.genre) out.tags = [fix.genre, ...(out.tags || []).filter((t) => t !== fix.genre)];
      if (fix.blurb) out.blurbSource = "";
      out.edited = fix;
    }
    // A Ukrainian edition names its author in Ukrainian too («Еріх Марія Ремарк», not «Erich Maria
    // Remarque»; Max 2026-10-23), when the author pages know the Ukrainian name. Search keeps both.
    // A Ukrainian author's name is Ukrainian on any book («Макс Кідрук»).
    if (!fix?.author && out.author && !/[а-яіїєґ]/i.test(out.author)) {
      const uk = this.authors?.ukName(out.author, /[а-яіїєґ]/i.test(out.title || ""));
      if (uk) (out.authorOrig = out.author), (out.author = uk);
    }
    out.href = this.slugs ? this.href(id) : `/book/${encodeURIComponent(id)}`;
    return out;
  }

  // The book's tags with our genres first: from its own tags and its editions' shop shelves, and when those
  // name no genre but «художня», from its translation's or original's (Max 2026-10-23: the Ukrainian
  // «Володар перснів» showed no «Фентезі»). The shop's own names stay after ours.
  genresOf(id, b, eds) {
    const own = b.tags || [];
    const names = [...own, ...(eds || []).flatMap(({ item }) => item.genres || [])];
    let ours = ourGenres(names);
    if (!ours.some((g) => g !== "художня")) {
      for (const t of this.translations?.get(id) || []) {
        const tb = this.lib.books[t] || this.shelfItems.get(t)?.item || this.seedBooks.find((x) => x.id === t);
        ours = [...new Set([...ours, ...ourGenres([...(tb?.tags || tb?.genres || []), ...(this.editions.get(t) || []).flatMap(({ item }) => item.genres || [])])])];
      }
    }
    // A classic is not genre romance, whatever its subjects say (Max 2026-10-23: «Лоліта» was «Любовні романи»).
    if (ours.includes("класика")) ours = ours.filter((g) => g !== "любовні романи");
    // A specific genre first, then «художня».
    ours.sort((x, y) => (x === "художня") - (y === "художня"));
    return [...new Set([...ours.slice(0, 3), ...own])];
  }

  // ---- the owner's hand edits of a book's title, author, description and cover, kept in meta `edits` ----
  edits() {
    if (this._edits) return this._edits;
    try {
      this._edits = JSON.parse(this.db.get("edits") || "{}") || {};
    } catch {
      this._edits = {};
    }
    return this._edits;
  }
  // One field of the owner's fix, the rest kept (the «російська / не російська» buttons on /admin/russian).
  editField(id, k, v) {
    id = this.canonical(id);
    return this.editBook(id, { ...(this.edits()[id] || {}), [k]: v });
  }
  // Books on readers' shelves that may be Russian yet pass isRussian(): a Cyrillic title without і ї є ґ,
  // or an author written the Russian way, with no language the owner or a catalog set (/admin/russian).
  russianSuspects() {
    const out = [];
    const ids = new Set([...this.entries.values()].flatMap((e) => Object.keys(e)).map((i) => this.canonical(i)));
    for (const id of ids) {
      const b = this.book(id);
      if (!b || b.edited?.language || isRussian(b) || /^(uk|укр)/i.test(b.language || "")) continue;
      const cyr = /[а-я]/i.test(b.title) && !/[іїєґ]/i.test(`${b.title} ${b.author}`);
      if (!cyr || langGuess(b.title) === "uk") continue;
      out.push({ ...b, readers: this.readersOf(id).length });
    }
    return out.sort((a, b) => b.readers - a.readers || a.title.localeCompare(b.title, "uk"));
  }

  // An empty field goes back to what the catalog says.
  editBook(id, patch) {
    id = this.canonical(id);
    const all = { ...this.edits() };
    const fix = {};
    for (const k of EDITABLE) {
      const v = k === "blurb" ? String(patch[k] ?? "").replace(/\r\n?/g, "\n").trim() : String(patch[k] ?? "").replace(/\s+/g, " ").trim();
      if (v && !(k === "genre" && !OUR_GENRES.has(v)) && !(k === "published" && !/^-?\d{1,4}$/.test(v))) fix[k] = v;
    }
    if (Object.keys(fix).length) all[id] = fix;
    else delete all[id];
    this.db.set("edits", JSON.stringify(all));
    this._edits = all;
    this._works = null;
    this.indexSearch();
    return this.book(id);
  }

  // book() plus its translations, for the book page (kept out of book() so the two don't recurse).
  bookPage(id) {
    const b = this.book(id);
    const translations = b && this.translationsOf(b.id);
    // The Ukrainian title from Wikidata is named only while no catalog has it: not as a translation, and
    // not as an edition either (MEGOGO Books gives «Марсіанин» the original title, so it joins The Martian).
    const uk = (b && this.ukTitles?.[b.id]?.uk) || "";
    const inCatalog = translations?.length || (b?.editions || []).some((e) => norm(e.title) === norm(uk) || /[а-яіїєґ]/i.test(e.title));
    // The original Haiku named, while no catalog has it (aiOrigs).
    const o = b && !translations.length && /[а-яіїєґ]/i.test(b.title || "") && this.aiOrigs().get(b.id);
    return b && { ...b, translations, ukTitle: inCatalog ? "" : uk, origTitle: o?.title || "", origAuthor: o?.title ? o.author : "", cycle: this.cycleOf(b.id) };
  }

  fromShelfItem(shelf, it) {
    return { id: it.id, title: it.title, author: it.author, altTitle: it.altTitle || "", cover: it.cover, tags: it.genres || [], links: [{ label: shelf.name, url: it.url }], source: shelf.id, shelf: shelf.id, blurb: require("./catalogs").about(it.blurb || ""), price: it.price, status: it.status, expected: it.expected || "", language: it.language, edition: it.edition || "", isbn: it.isbn || "", volume: it.volume || 0, bundle: !!it.bundle, format: it.format || (shelf.kind === "free" ? "e-book" : shelf.kind === "audio" ? "аудіо" : "папір"), narrator: it.narrator || "", duration: it.duration || "", subscription: !!it.subscription };
  }

  addBook({ title, author, cover, links, source = "manual", ...more }) {
    let id = slugify(title);
    while (this.book(id)) id += "-2";
    this.lib.books[id] = { id, title: title.trim(), author: (author || "").trim(), cover: cover || "", tags: [], links: links || [], source, ...more };
    this.writeBook(id);
    this._works = null;
    this.indexSlugs();
    this.indexSearch();
    return this.lib.books[id];
  }

  updateBook(id, patch) {
    const b = this.lib.books[id] || this.book(id);
    if (!b) return null;
    const copy = { ...b, ...patch, id };
    this.lib.books[id] = copy; // seed and shelf books become own copies once edited
    this.writeBook(id);
    return copy;
  }

  // ---- finding a work from the outside (the Goodreads import) ----
  // Every work by ISBN and by title: the library and the shelves, with original titles and the
  // Ukrainian titles Wikidata knows for foreign books.
  workIndex() {
    if (this._works) return this._works;
    const byIsbn = new Map();
    const byTitle = new Map(); // norm(title) -> [{ id, author }]
    const put = (t, id, author) => {
      const k = norm(t);
      if (k.length < 2) return;
      const list = byTitle.get(k) || byTitle.set(k, []).get(k);
      if (!list.some((w) => w.id === id)) list.push({ id, author: author || "" });
    };
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books)]) {
      const id = this.canonical(b.id);
      const own = this.lib.books[b.id] || b;
      for (const i of isbnsOf(own)) byIsbn.set(i, id);
      for (const t of [own.title, own.altTitle, b.title, b.altTitle]) put(t, id, own.author || b.author);
    }
    for (const { item } of this.shelfItems.values()) {
      const id = this.canonical(item.id);
      if (isbnKey(item.isbn).length >= 10 && !byIsbn.has(isbnKey(item.isbn))) byIsbn.set(isbnKey(item.isbn), id);
      for (const t of [item.title, item.altTitle]) put(t, id, item.author);
    }
    for (const [id, { uk, ukAuthor }] of Object.entries(this.ukTitles || {})) if (this.book(id)) put(uk, this.canonical(id), ukAuthor);
    return (this._works = { byIsbn, byTitle });
  }

  // Every work with exactly this title (or original title): a pasted list often has titles only.
  worksTitled(title) {
    return [...new Set((this.workIndex().byTitle.get(norm(title)) || []).map((w) => w.id))];
  }

  // The work for a book named from outside ({ title, author, isbns }), or null. An ISBN is enough on
  // its own; a title needs the same author (a surname in common, in either alphabet, a typo allowed),
  // unless only one work has that title and the title is not a single short word.
  findWork({ title, author = "", isbns = [] }) {
    const { byIsbn, byTitle } = this.workIndex();
    for (const i of isbns) if (byIsbn.has(isbnKey(i))) return byIsbn.get(isbnKey(i));
    const names = authorNames;
    const mine = names(author);
    const alike = (a) => mine.length > 0 && names(a).length > 0 && sameAuthor(author, a);
    // The title as given, then without a subtitle after a colon («Sapiens: A Brief History of Humankind»).
    const variants = [...new Set([norm(title), norm(String(title).split(/[:(]/)[0]), norm(String(title).split(/\.\s/)[0])].filter((t) => t.length >= 2))];
    for (const t of variants) {
      const found = byTitle.get(t) || [];
      const byAuthor = found.filter((w) => alike(w.author));
      if (byAuthor.length) return byAuthor[0].id;
      if (found.length === 1 && t === norm(title) && (t.includes(" ") || t.length >= 8) && (!norm(author) || !names(found[0].author).length)) return found[0].id;
    }
    return null;
  }

  // Put rows of an import on a reader's shelf: each row is an entry with either the id of a work it
  // matched or the book to make ({ title, author, isbns, goodreadsId }). A book the reader already has
  // keeps what it had and takes only what was missing. Rows come in the order they should sit in.
  importEntries(reader, rows, { source = "goodreads" } = {}) {
    const entries = this.entriesOf(reader);
    let order = Object.values(entries).reduce((m, e) => Math.max(m, e.order ?? -1), -1) + 1;
    const now = new Date().toISOString();
    const result = { added: 0, updated: 0, created: [] };
    this.db.tx(() => {
      for (const r of rows) {
        let id = r.id && this.book(r.id) ? this.canonical(r.id) : null;
        if (id && r.cycle && this.lib.books[id] && !this.lib.books[id].cycle) (this.lib.books[id].cycle = r.cycle), this.writeBook(id);
        if (!id) {
          id = slugify(r.title);
          while (this.book(id)) id += "-2";
          this.lib.books[id] = { id, title: r.title.trim(), author: (r.author || "").trim(), cover: "", tags: [], links: [], source, ...(r.isbns?.length ? { isbns: r.isbns } : {}), ...(r.cover ? { cover: r.cover } : {}), ...(r.ol ? { ol: r.ol } : {}), ...(r.published ? { published: r.published } : {}), ...(r.blurb ? { blurb: r.blurb, blurbSource: r.blurbSource || "" } : {}), ...(r.pages ? { pages: r.pages } : {}), ...(r.links?.length ? { links: r.links } : {}), ...(r.goodreadsId ? { goodreads: r.goodreadsId } : {}), ...(r.cycle ? { cycle: r.cycle } : {}), ...(r.appleId ? { apple: r.appleId } : {}) };
          this.writeBook(id);
          result.created.push(this.lib.books[id]);
        }
        // An import is history, not news: the entry is dated when the book was read (or added) on Goodreads,
        // so a hundred old books don't fill the feed as «сьогодні» (Max, 2026-10-20). An entry the reader
        // already had keeps its own date.
        const imported = { status: r.status || "", year: r.year && !this.publishedYear(id, r.year) ? r.year : null, rating: r.rating ?? null, note: r.note || "", copy: r.copy || "", order: order++, added: r.added || now.slice(0, 10), updated: r.read || r.touched || r.added || now, ...(r.kids ? { kids: true } : {}) };
        const cur = entries[id];
        entries[id] = cur ? { ...mergeEntries(cur, imported), updated: cur.updated || cur.added || imported.updated } : imported;
        this.writeEntry(reader, id, entries[id]);
        cur ? result.updated++ : result.added++;
      }
    });
    if (rows.some((r) => r.cycle)) this.linkCycles();
    if (result.created.length) {
      this._works = null;
      this.indexSlugs();
      this.indexSearch();
    }
    return result;
  }

  // ---- library entries ----

  entry(reader, id) {
    return (reader && this.entriesOf(reader)[this.canonical(id)]) || null;
  }

  // The reader's library membership by any id, edition ids included (for the shelf cards).
  inLibrary(reader) {
    if (!reader) return new Map();
    const entries = this.entriesOf(reader);
    const m = new Map(Object.entries(entries));
    for (const [w, ts] of this.translations || []) if (!m.has(w)) for (const t of ts) if (entries[t]) m.set(w, entries[t]);
    for (const [alias, c] of this.aliases) if (m.has(c)) m.set(alias, m.get(c));
    return m;
  }

  // A «read in» year that is the book's publication year (± 1) of an old book: a chat assistant over /mcp or a
  // pasted «Фундація (1951)» gave when the book came out, not when the reader read it (Vova, 2026-10-24:
  // «прочитано у 1952», and the edit form then refused it, «значення має бути більше 1990»).
  publishedYear(id, year) {
    if (!(year < 2000)) return false;
    const ids = [this.canonical(id), ...(this.translations?.get(this.canonical(id)) || [])];
    return ids.some((x) => Math.abs((Number(this.book(x)?.published) || 0) - year) <= 1);
  }

  // Such years already saved go (once, meta `fix:readyear` keeps what changed).
  dropPublishedYears() {
    if (this.db.get("fix:readyear")) return null;
    const fixed = [];
    for (const [reader, entries] of this.entries)
      for (const [id, e] of Object.entries(entries))
        if (e.year && this.publishedYear(id, e.year)) {
          fixed.push({ reader, id, year: e.year });
          e.year = null;
          this.writeEntry(reader, id, e);
        }
    this.db.set("fix:readyear", JSON.stringify({ at: new Date().toISOString(), readers: new Set(fixed.map((f) => f.reader)).size, fixed }));
    return fixed;
  }

  setEntry(reader, id, patch) {
    id = this.canonical(id);
    if (!this.book(id)) return null;
    if (patch.year && this.publishedYear(id, patch.year)) patch = { ...patch, year: null };
    const entries = this.entriesOf(reader);
    const cur = entries[id] || { status: "", year: null, rating: null, note: "", copy: "", order: Object.keys(entries).length, added: new Date().toISOString().slice(0, 10) };
    const next = { ...cur, ...patch, updated: new Date().toISOString() };
    if (next.rating === "" || next.rating === undefined) next.rating = cur.rating ?? null;
    if (!next.kids) delete next.kids;
    entries[id] = next;
    this.writeEntry(reader, id, next);
    return next;
  }

  removeEntry(reader, id) {
    id = this.canonical(id);
    delete this.entriesOf(reader)[id];
    this.writeEntry(reader, id, null);
    // A book someone typed in by hand goes with the last entry that had it.
    if (this.lib.books[id]?.source === "manual" && ![...this.entries.values()].some((e) => e[id])) {
      delete this.lib.books[id];
      this.writeBook(id);
    }
  }

  // Every library row of the reader with its book: newest year first, books without a year last, and
  // within a year the reader's order (Books.md order for Max). The year comes first so that a shelf built
  // in several steps (an import after books added by hand, two imports) never shows a year twice
  // (Max, 2026-10-20: «каша з роками» on an imported shelf).
  // Within a year (and under «Без дати»), books added here come first, the last added on top (Max,
  // 2026-10-22); Books.md rows have no `added` and keep their own order below them.
  library(reader) {
    const rank = (r) => (r.added ? -(r.order ?? 0) : 1e9 + (r.order ?? 0));
    return Object.entries(reader ? this.entriesOf(reader) : {})
      .map(([id, e]) => ({ id, ...e, book: this.book(id) }))
      .filter((r) => r.book)
      .sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || rank(a) - rank(b));
  }

  // ---- shelves and subscriptions ----

  shelf(id) {
    return this.shelves.find((s) => s.id === id) || null;
  }

  subscribed(reader, id) {
    return !!reader && this.subscriptions(reader).includes(id);
  }

  toggleSubscription(reader, id) {
    if (!this.shelf(id)) return null;
    const on = !this.subscribed(reader, id);
    this.subs.set(reader, on ? [...this.subscriptions(reader), id] : this.subscriptions(reader).filter((s) => s !== id));
    this.db.prepare(on ? "INSERT OR IGNORE INTO subscriptions (reader, shelf) VALUES (?, ?)" : "DELETE FROM subscriptions WHERE reader = ? AND shelf = ?").run(reader, id);
    return on;
  }
}

module.exports = { mainGenres, isRussian, langGuess, Store, slugify, soundOf, norm, workName, OWNER };
