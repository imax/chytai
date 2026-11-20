// «Адмінка» (Max 2026-11-20: «адмінстатистику читалки прямо в читалці, в моєму аккаунті, щоб воно не відправляло на
// сайт»): the owner's page in the panel, the same sections as the site's /admin/reader (web/admin.js readerAppPage),
// drawn from GET /api/admin (server/index.js collectStats). Names and titles stay plain text: nothing leads to the site.
// home.js shows it as page «admin»; «Вимкнути» / «Увімкнути» go through data-act="admin-off".
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const fmtN = (v) => Number(v || 0).toLocaleString("uk-UA");
  const n = (v) => (v ? fmtN(v) : `<span class="m">·</span>`);
  const usd = (v) => (v == null ? "—" : v > 0 && v < 0.01 ? "<$0,01" : `$${v.toFixed(2).replace(".", ",")}`);
  const mins = (m) => (m < 120 ? `${fmtN(m)} хв` : `${fmtN(Math.round(m / 60))} год`);
  const short = (day) => `${Number(day.slice(8, 10))}.${day.slice(5, 7)}`;
  const fileTitle = (name) => String(name || "").split("/").pop().replace(/\.(epub|pdf|fb2|mobi|azw3?|paper)$/i, "");
  const ago = (ts) => {
    if (!ts) return "—";
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 2) return "щойно";
    if (min < 60) return `${min} хв тому`;
    const h = Math.round(min / 60);
    return h < 36 ? `${h} год тому` : `${Math.round(h / 24)} дн тому`;
  };
  const head = (title) => `<div class="r-sec-head"><h2>${title}</h2></div>`;
  // A column name starting with «~» is a text column (left, wraps).
  const tbl = (cols, rows, cls = "") => `<div class="r-adm-tbl"><table class="r-adm${cls ? ` ${cls}` : ""}"><thead><tr>${cols.map((c) => (c.startsWith("~") ? `<th class="tx">${c.slice(1)}</th>` : `<th>${c}</th>`)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const note = (t) => `<p class="r-adm-note">${t}</p>`;
  const who = (r, id = r.id) => `${esc(r.name || r.username || id)}${r.username ? ` <span class="m u">@${esc(r.username)}</span>` : ""}`;
  const tile = (v, label, sub = "") => `<div class="r-jt"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;

  const DEV = { "iphone-app": "iPhone, застосунок", "android-app": "Android, застосунок", "mac-app": "Mac, застосунок", app: "Застосунок", "iphone-browser": "iPhone, браузер", "android-browser": "Android, браузер", "desktop-browser": "Компʼютер, браузер" };
  const VIEW = { "home:home": "Головна", "home:discover": "Відкрити", "home:notes": "Нотатки", "home:wish": "Хочу прочитати", "home:club": "Клуб", pdf: "PDF", book: "книжка", other: "інше" };

  function html(s) {
    const sum = (xs, f) => xs.reduce((a, x) => (a == null || f(x) == null ? null : a + f(x)), 0);
    const week = s.users.filter((u) => u.activeWeek);
    let out = `<section class="r-adm-page"><h1 class="r-jh">Адмінка</h1>
      <div class="r-jtiles">${tile(fmtN(week.length), "читачів за 7 днів")}${tile(fmtN(s.totals.week), "пояснень за 7 днів", `${fmtN(s.totals.today)} сьогодні`)}${s.notes ? tile(fmtN(s.notes.week), "нотаток за 7 днів", `${fmtN(s.notes.today)} сьогодні`) : ""}${tile(usd(sum(s.days.slice(0, 30), (d) => d.cost)), "Claude за 30 днів")}</div></section>`;

    // Readers: those who opened something; the last 7 days first, the rest folded.
    const users = s.users.filter((u) => u.lastBook || u.read30 || u.total || u.notesTotal);
    const idle = s.users.length - users.length;
    const off = (u) => (u.owner ? "" : `<button class="r-adm-btn${u.off ? "" : " danger"}" data-act="admin-off" data-id="${esc(u.id)}" data-off="${u.off ? "" : "1"}">${u.off ? "Увімкнути" : "Вимкнути"}</button>`);
    const last = (u) => (u.lastBook ? `${esc(u.lastTitle || fileTitle(u.lastBook))}${u.lastOpened ? ` <span class="m">${ago(u.lastOpened)}</span>` : ""}` : `<span class="m">—</span>`);
    const readersTbl = (list) => tbl(["Читач", "~Читає", "Хв сьогодні", "7 днів", "30", "Пояснень, 7 дн.", "Нотаток, 7 дн.", "Claude, 30 дн.", ""],
      list.map((u) => `<tr${u.owner ? ' class="me"' : ""}><th>${who(u)}${u.off ? ` <span class="m">вимкнено</span>` : ""}</th><td class="tx">${last(u)}</td><td>${n(u.readToday)}</td><td>${n(u.readWeek)}</td><td>${n(u.read30)}</td><td>${n(u.week)}</td><td>${n(u.notesWeek)}</td><td>${u.cost30 ? usd(u.cost30) : n(0)}</td><td>${off(u)}</td></tr>`));
    const recent = users.filter((u) => u.activeWeek);
    const older = users.filter((u) => !u.activeWeek);
    out += `<section class="r-adm-sec">${head("Читачі")}
      ${note(`За 7 днів читали ${fmtN(week.length)} з ${fmtN(s.users.length)}, разом ${mins(s.users.reduce((a, u) => a + (u.readWeek || 0), 0))}, ${fmtN(s.users.filter((u) => u.readWeek >= 15).length)} по 15+ хв.`)}
      ${recent.length ? readersTbl(recent) : note("За 7 днів ніхто не заходив.")}
      ${older.length ? `<details class="r-adm-more"><summary>Ще ${fmtN(older.length)}, давніше 7 днів</summary>${readersTbl(older)}</details>` : ""}
      ${note(`${idle ? `Ще ${fmtN(idle)} входили, але нічого не відкрили. ` : ""}Хвилини: книжка на екрані й читач щось робив за 3 хв. Запобіжник ${fmtN(s.accountCap)} пояснень на день. «Вимкнути» закриває лише Читалку.`)}</section>`;

    // Books by minutes in 30 days; the same title in several libraries is one row.
    const byBook = new Map();
    for (const r of s.reading || []) {
      const title = r.title || fileTitle(r.book);
      const key = `${r.paper ? "paper" : "file"}:${title.toLowerCase()}`;
      const g = byBook.get(key) || { title, paper: r.paper, today: 0, week: 0, month: 0, readers: [] };
      g.today += r.today;
      g.week += r.week;
      g.month += r.month;
      g.readers.push(r);
      byBook.set(key, g);
    }
    const top = [...byBook.values()].sort((a, b) => b.month - a.month).slice(0, 40);
    out += `<section class="r-adm-sec">${head("Книжки")}${top.length
      ? tbl(["Книжка", "~Хто читав, хв", "Сьогодні", "7 днів", "30"], top.map((g) => `<tr><th class="tx">${esc(g.title)}${g.paper ? ` <span class="m">паперова</span>` : ""}</th><td class="tx">${g.readers.sort((a, b) => b.month - a.month).map((r) => `${esc(r.name || r.username || r.id)} <span class="m">${fmtN(r.month)}</span>`).join(", ")}</td><td>${n(g.today)}</td><td>${n(g.week)}</td><td>${n(g.month)}</td></tr>`)) + note("За 30 днів. Паперова: час на її сторінці в Читалці.")
      : note("Ще ніхто не читав.")}</section>`;

    const fd = s.firstDays;
    if (fd?.signed) {
      const step = (v) => `${fmtN(v)} <span class="m">${fmtN(Math.round((100 * v) / fd.signed))}%</span>`;
      out += `<section class="r-adm-sec">${head("Перші дні")}${tbl(["", ""], [["Зареєструвались за 60 днів", fmtN(fd.signed)], ["Відкрили книжку", step(fd.opened)], ["Прочитали 10 хв за перший тиждень", step(fd.ten)], ["Читали у два різні дні", step(fd.twoDays)]].map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`), "kv")}</section>`;
    }

    const st = s.stops;
    const left = st ? st.left[3] + st.left[10] + st.left[50] + st.left[95] : 0;
    if (st && st.finished + st.reading + left) {
      out += `<section class="r-adm-sec">${head("Де кидають книжки")}
        ${note(`За 90 днів відкрили ${fmtN(st.finished + st.reading + left)} книжок: дочитали ${fmtN(st.finished)}, читають ${fmtN(st.reading)}, покинули ${fmtN(left)}: до 3% ${fmtN(st.left[3])}, до 10% ${fmtN(st.left[10])}, до половини ${fmtN(st.left[50])}, після половини ${fmtN(st.left[95])}.`)}
        ${st.books.length ? `<details class="r-adm-more"><summary>Покинуті книжки, новіші зверху</summary>${tbl(["Книжка", "Хто", "Де", "Востаннє"], st.books.map((r) => `<tr><th class="tx">${esc(r.title || fileTitle(r.book))}</th><td>${who(r)}</td><td>${fmtN(r.pct)}%</td><td>${ago(r.at)}</td></tr>`))}</details>` : ""}
        ${note("Покинута: 14 днів не відкривали й не дочитали до 95%.")}</section>`;
    }

    // Every feature: who saw it, who used it in 7 and 30 days, taps, mine.
    const g = (x) => (x.guests ? ` <span class="m">+ гості</span>` : "");
    const readMonth = s.users.filter((u) => u.read30 > 0).length;
    if (s.features?.length) {
      out += `<section class="r-adm-sec">${head("Функції")}${tbl(["Функція", "Бачили", "Читачів, 7 дн.", "30 дн.", "Разів", "Ви"],
        s.features.map((f) => `<tr${f.use.readers || f.use.max || f.seen?.readers ? "" : ' class="dim"'}><th>${esc(f.label)}</th><td>${f.seen ? `${fmtN(f.seen.readers)}${g(f.seen)}` : ""}</td><td>${n(f.use.readers7)}</td><td>${n(f.use.readers)}${g(f.use)}</td><td>${n(f.use.n)}</td><td>${f.use.max ? fmtN(f.use.max) : ""}</td></tr>`))}
        ${note(`Читачі, які скористались, без вас; гості окремо. «Бачили», «Разів» і «Ви» за 30 днів; «Бачили» там, де Читалка показує функцію сама. Читали за 7 днів ${fmtN(week.length)}, за 30 днів ${fmtN(readMonth)}.`)}</section>`;
    }

    const words = s.words || [];
    if (words.length) {
      const pct = (a, b) => (b ? ` <span class="m">${Math.round((100 * a) / b)}%</span>` : "");
      out += `<section class="r-adm-sec">${head("Одне слово")}${tbl(["День", "Виділили", "Одразу", "Чекали", "Коштувало"], words.map((r) => {
        const at = r.list + r.ahead;
        return `<tr><th>${short(r.day)}</th><td>${fmtN(r.all)}${r.max ? ` <span class="m">ваших ${fmtN(r.max)}</span>` : ""}</td><td>${fmtN(at)}${pct(at, r.all)}</td><td>${fmtN(Math.max(0, r.all - at))}</td><td>${usd(s.wordCost?.[r.day] || 0)}</td></tr>`;
      }))}${note("«Одразу»: значення було в словничку книжки, без запиту.")}</section>`;
    }

    const names = s.uiNames || {};
    const ui = (s.ui || []).slice(0, 40);
    out += `<section class="r-adm-sec">${head("Що натискають")}${ui.length
      ? `<details class="r-adm-more"><summary>${fmtN(ui.length)} кнопок за 30 днів</summary>${tbl(["Що", "Читачів", "Натискань"], ui.map((r) => `<tr><th>${esc(names[r.name] || r.name)}${names[r.name] ? ` <span class="m">${esc(r.name)}</span>` : ""}</th><td>${n(r.readers)}${r.guests ? ` <span class="m">+ гості</span>` : ""}</td><td>${n(r.n)}</td></tr>`))}</details>${note(`За 30 днів читали ${fmtN(readMonth)}. Гортання не рахуємо.`)}`
      : note("Ще нічого.")}</section>`;

    const devs = s.offline?.devices || [];
    const offWho = s.offline?.readers || [];
    out += `<section class="r-adm-sec">${head("Без мережі")}${devs.length
      ? tbl(["Пристрій", "Читали, хв", "Без мережі", "Відкрили", "Не було"], devs.map((r) => `<tr><th>${esc(DEV[r.dev] || r.dev)}</th><td>${n(r.read)}</td><td>${n(r.off)}</td><td>${n(r.opened)}</td><td>${n(r.missing)}</td></tr>`)) + note(`За 30 днів. ${offWho.length ? `Без мережі читали: ${offWho.map((r) => `${esc(r.name || r.username || r.id)} <span class="m">${fmtN(r.off)} хв</span>`).join(", ")}.` : "Без мережі ще ніхто не читав."}`)
      : note("Ще нічого.")}</section>`;

    const gone = s.gone?.rows || [];
    const dur = (sec) => (sec < 90 ? `${fmtN(sec)} с` : sec < 5400 ? `${fmtN(Math.round(sec / 60))} хв` : `${fmtN(Math.round(sec / 3600))} год`);
    const where = (r) => (!r.view.startsWith("home") && r.book ? `${esc(VIEW[r.view] || r.view)}: ${esc(r.title || fileTitle(r.book))}` : esc(VIEW[r.view] || r.view || "—"));
    const held = (r) => [`картинки ${fmtN(r.imgMB)} МБ`, r.canvasMB ? `PDF ${fmtN(r.canvasMB)} МБ` : "", `${fmtN(r.nodes)} елементів`, `${fmtN(r.books)} книжок`, `жила ${dur(r.up)}`].filter(Boolean).join(", ");
    out += `<section class="r-adm-sec">${head("Вивантаження")}${gone.length
      ? `${note(`За 30 днів: ${(s.gone.byDay || []).map((d) => `${short(d.day)} ${fmtN(d.n)}${d.bg ? ` (у фоні ${fmtN(d.bg)})` : ""}`).join(", ")}.`)}<details class="r-adm-more"><summary>Останні ${fmtN(gone.length)}</summary>${tbl(["Коли", "Хто", "Пристрій", "~Що на екрані", "Де", "~Що тримала"], gone.map((r) => `<tr><th>${ago(r.at)}</th><td>${r.acct ? who(r, r.acct) : `<span class="m">гість</span>`}</td><td>${esc(DEV[r.dev] || r.dev)}</td><td class="tx">${where(r)}${r.restored ? ` <span class="m">відкрили знову</span>` : ""}</td><td>${r.bg ? `у фоні${r.hid ? ` ${dur(r.hid)}` : ""}` : "<b>на екрані</b>"}</td><td class="tx">${held(r)}</td></tr>`))}</details>${note("Телефон вбиває сторінку, коли бракує пам'яті, найчастіше у фоні. «На екрані»: забагато тримала сама сторінка.")}`
      : note("Ще жодного.")}</section>`;

    const days = s.days.slice(0, 30);
    out += `<section class="r-adm-sec">${head("Вартість")}<details class="r-adm-more"><summary>По днях і моделях</summary>
      ${tbl(["День", "Пояснень", "Токенів на вході", "На виході", "Claude"], days.map((d) => `<tr><th>${short(d.day)}</th><td>${n(d.explains)}</td><td>${fmtN(d.input + d.cacheRead + d.cacheWrite)}</td><td>${fmtN(d.output)}</td><td>${usd(d.cost)}</td></tr>`))}
      ${s.models.length ? tbl(["Модель", "Запитів", "Токенів на вході", "На виході", "Claude"], s.models.map((m) => `<tr><th>${esc(m.model.replace(/^claude-/, ""))}</th><td>${fmtN(m.requests)}</td><td>${fmtN(m.input + m.cacheRead + m.cacheWrite)}</td><td>${fmtN(m.output)}</td><td>${usd(m.cost)}</td></tr>`)) : ""}
      ${note("Приблизно, за тарифами API; вхідні токени разом з кешем.")}</details></section>`;
    return out;
  }

  window.AdminView = { html };
})();
