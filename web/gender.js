// A reader's gender guessed from the name they gave (Max, 2026-11-04: «Якщо це Тетяна, то вона зареєструвалась,
// а не зареєструвався»). Kept in readers.gender: "f", "m", or "" when the name doesn't say (Саша, Alex, a
// nickname); Max fixes it on /admin/readers and then it is his (readers.gender_set). Never shown to the reader;
// used for the admin's wording and for letters.

const words = (s) => s.split(/\s+/).filter(Boolean);
const FEMALE = new Set(words(`
  олена оленка олена ольга оля олька олюся анна аня ганна ганнуся тетяна таня тетянка наталя наталія наталі наташа
  ірина іра ірочка юлія юля марія маша марічка мар'яна марʼяна оксана ксана катерина катя катруся людмила люда люба
  любов світлана світлана лариса галина галя надія надя віра вікторія віка вероніка дарина даша дар'я дарʼя софія
  соня анастасія настя христина кристина валентина ліна алла аліна альона олеся леся лілія ліля яна ярослава уляна
  ульяна зоряна роксолана богдана діана діна ася марта ніна тамара раїса зоя інна евеліна євгенія ксенія ксеня
  поліна валерія єлизавета ліза лиза елла емілія мирослава станіслава владислава злата мілана олександра антоніна
  тоня жанна віолета ганнa марина маринка стефанія соломія орися ореста василина іванна мирослава аделіна каріна
  кіра ілона майя мая регіна сніжана таміла тереза емма елеонора елена татьяна наталья ирина юлия мария екатерина
  светлана надежда вера виктория дарья полина ксения елизавета лена ира алёна алена анжела анжеліка
  olena olenka olga olha olia olya olka anna anya ania hanna ganna tetiana tetyana tatiana tatyana tanya tania
  natalia nataliia natalya nataliya natali natasha iryna irina ira yulia yuliia yuliya julia juliya maria mariia
  mariya masha mariana maryana marianna oksana kateryna katerina katya katia kate catherine kathy liudmyla lyudmila
  ludmila liuba lyuba svitlana svetlana larysa larisa halyna galina nadiia nadia nadya vira vera viktoriia viktoriya
  victoria vika veronika veronica daryna dasha daria dariia darya sofiia sofia sofiya sophia sonya sonia anastasiia
  anastasia nastya nastia khrystyna kristina christina valentyna valentina lina alla alina alona alyona olesia olesya
  lesia lesya liliia lilia lily yana jana yaroslava uliana ulyana zoriana roksolana bohdana diana dina asya asia
  marta martha nina tamara inna evelina yevheniia kseniia ksenia polina valeriia valeria yelyzaveta elizaveta
  elizabeth liza lisa ella emilia myroslava zlata milana oleksandra zhanna lucy lena mary tia marina maryna marinka
  solomiia solomiya ivanna karina kira ilona maya regina snizhana emma helen helena elena kate anne ann jane julie
  sarah emily alice eva iva ivanka
`));
const MALE = new Set(words(`
  олександр олексій андрій анатолій антон артем артур богдан борис вадим валентин валерій василь віктор віталій
  владислав влад володимир вова вовчик в'ячеслав вʼячеслав вячеслав геннадій гена георгій гліб григорій давид денис
  дмитро дмитрик діма дима євген єгор ігор ілля іван йосип кирило костянтин костя леонід лев левко макар максим
  макс марко мирослав михайло миша мишко микита микола назар олег остап павло паша петро роман ростислав руслан
  сергій серж семен станіслав стас степан стефан тарас тимофій тимур толік толя федір філіп юрій юра ярослав ян
  захар данило даниїл еміль едуард арсеній всеволод зиновій любомир орест яків нестор платон родіон сашко андрійко
  лука кузьма фома хома сава савва ілько славік вітя вадик женька алексей александр андрей дмитрий сергей юрий игорь
  илья николай михаил евгений владимир виктор виталий валерий геннадий петр пётр фёдор федор константин кирилл павел
  иван анатолий вячеслав станислав ярослав григорий
  oleksandr olexandr alexander alexandr aleksandr oleksii oleksiy olexii alexey alexei andrii andriy andrew andrey
  andrei anatolii anatoliy anton artem artur arthur bohdan bogdan borys boris vadym vadim valentyn valentin valerii
  valeriy valery vasyl vasil vasiliy viktor victor vitalii vitaliy vitaly vladyslav vladislav vlad volodymyr
  vladimir vova viacheslav vyacheslav slavik hennadii hennadiy gennadii gennadiy gennady genn gena hena heorhii
  george georgii hlib gleb hryhorii grigoriy david denys denis dmytro dmitro dmitry dmitriy dima yevhen yevgen
  evgen evgeny evgeniy eugene yehor egor ihor igor illia ilya ilia ivan kyrylo kirill kostiantyn konstantin kostya
  leonid lev maksym maxim max maks marko mark myroslav mykhailo mykhaylo michael mikhail misha mykyta nikita mykola
  nikolay nikolai nazar oleh oleg ostap pavlo pavel paul petro peter petr roman rostyslav rostislav ruslan serhii
  serhiy sergii sergiy sergey sergei serge stanislav stas stepan stefan stephen taras tymofii timofey tymur timur
  tolik tolya fedir fedor fyodor pylyp philip yurii yuriy yuri yura yaroslav yan zakhar danylo daniel danil danila
  emil eduard arsenii arseniy orest yakiv rodion john james tom thomas alexandre luka luca
`));
// Names that are either (Саша, Женя, Alex): the surname may still say.
const EITHER = new Set(words(`саша саня женя валя слава шура сашуня ніка alex sasha sania sanya zhenia zhenya valia valya slava nika chris kim`));

const LETTERS = /[^a-zа-яіїєґё'ʼ]+/gi;
function guessGender(name) {
  const tokens = String(name || "").toLowerCase().replace(/’/g, "'").split(LETTERS).filter((t) => t.length > 1);
  // «Marin_k_a», «Olga_M»: a name broken by underscores is also tried whole.
  const joined = String(name || "").toLowerCase().split(/\s+/)[0]?.replace(LETTERS, "");
  for (const t of [...tokens, joined]) {
    if (!t) continue;
    if (FEMALE.has(t)) return "f";
    if (MALE.has(t)) return "m";
  }
  // A surname: Ковтонюк says nothing, Артушевська and Щасливий do.
  for (const t of tokens.slice(1)) {
    if (/(ськ|цьк|зьк)а$|(ов|ев|єв|ін|їн)а$|(ska|cka|tska|ova|eva|ina)$/.test(t)) return "f";
    if (/(ськ|цьк|зьк)ий$|(ов|ев|єв|ін|їн)$|(ий|ій)$|(skyi|skyy|skiy|sky|ov|ev)$/.test(t)) return "m";
  }
  // A Ukrainian name not in the lists: in -а/-я it is nearly always a woman's (Вільха, Ярина).
  const first = tokens[0];
  if (first && !EITHER.has(first) && /[а-яіїєґ]{2,}[ая]$/.test(first)) return "f";
  return "";
}

// A verb in the past tense for the reader: «відкрив» → «відкрила», «зареєструвався» → «зареєструвалась»,
// «увійшов» → «увійшла», «зберіг» → «зберегла»; unknown gender → «відкрив(ла)». Anything else stays.
function past(word, gender) {
  const f = /вся$/.test(word) ? word.slice(0, -3) + "лась" : /шов$/.test(word) ? word.slice(0, -2) + "ла" : word === "зберіг" ? "зберегла" : /в$/.test(word) ? word.slice(0, -1) + "ла" : null;
  if (!f) return word;
  if (gender === "f") return f;
  if (gender === "m") return word;
  return /вся$/.test(word) ? `${word}(лась)` : `${word}(ла)`;
}

// The same for any pair of words, for letters: said(reader, "радий", "рада", "раді").
function said(gender, m, f, neutral = m) {
  return gender === "f" ? f : gender === "m" ? m : neutral;
}

module.exports = { guessGender, past, said };
