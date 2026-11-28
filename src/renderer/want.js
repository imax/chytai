// «Хочу прочитати» (Max 2026-11-24, in place of Scratchpad): the books on the reader's «Хочу прочитати» shelf on
// chytai.org.ua as a shelf of covers (Max chose design B of canvas C4zbe7sBdsPD1z41gChjEj): «Можна читати зараз»
// (one's own file, a free-shelf book), «Купити або взяти напрокат» (the shops, BookFlow, free texts online) and «Поки немає»
// (was «Поки ніде», folded; Max 2026-11-25: shown open, after «Бібліотеки»). Under a cover «Читати» or the lowest price («90 ₴»); a tap on the cover = the book's card
// (paper.js `Paper.card`): «Читати», «Де взяти» (one line a format, as the book page's «Де взяти»; then the same
// work in its other language, the original or the Ukrainian translation, with Amazon and the like), «Про книжку»
// and the book's page. GET /api/want (server/index.js → the site's /api/reader-want). A page in the panel after
// «Мої книжки» (home.js page «want»). Taps count by data-act (reading-time.js): act-want-*.
// «Бібліотеки» (Max 2026-11-25), the last part: empty until the reader picks one or more library branches
// (#libs-dialog, settings `libraries`, 5 at most); then the books those branches hold, from the site's cache of the
// libraries' catalogs (`lib` per book). Books the site hasn't asked them about yet are asked in the background
// (`libs.unchecked`), so the page asks again every half minute while it is open.
// «Мої книгарні» (Max 2026-11-26, variant A of canvas Ubw9pea9pkEN36tsnPXwRi), above «Купити»: empty until the reader
// picks up to 3 shops (the same dialog, tabs «Книгарні» / «Видавництва», settings `shops` by name); then the books in
// stock there now (the site's `stock` per book and per version: name -> [price, url, format]), the price under the
// cover, with the shop's name when several are picked. The card puts those shops first in «Де взяти», in bold.
// Adding books here (Max 2026-11-28, bot №59, variant A of canvas 918W2YwaxBMhztzimvn5B5): a search field under the
// count; while it holds words the shelf gives way to «Уже у списку» (the list's own books with them) and «Каталог
// Chytai» (`catalogFind`, as «Додати книжку») with «Хочу прочитати» on each row (`mentionWant` → the site's
// /api/reader-wantit), then «✓ У списку».
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const KIND = { "e-book": "E-book", папір: "Папір", аудіо: "Аудіо" };
  const SPIN = `<span class="spinner"></span>`;

  let books = null; // the last answer
  let asking = false;
  let failed = false;
  let picks = []; // the reader's library branches, [{ lib, branch }]
  let libs = null; // { unchecked } for the picks
  let myShops = []; // the reader's shops by name, SHOPS_MAX at most
  const SHOPS_MAX = 5; // Max 2026-11-27, bot №85 (was 3)
  let shopKinds = {}; // name -> { kind: "shop" | "publisher", formats }
  let libBusy = false; // the picks changed, the answer for them not here yet
  let again = null; // the timer that asks again while the libraries are being checked
  let tries = 0;

  const shown = () => document.querySelector("#shell")?.dataset.page === "want";

  async function load(fresh) {
    if (asking) return;
    asking = true;
    const r = await window.reader.want?.(fresh);
    asking = false;
    if (r?.books) (books = r.books), (libs = r.libs || null), (picks = r.picks || picks), (myShops = r.myShops || myShops), (shopKinds = r.shops || {}), (failed = false), (libBusy = false);
    else failed = !books;
    // The count beside «Хочу прочитати» in the panel, as «Мої книжки» (Max 2026-11-26).
    const n = document.querySelector("#r-n-want");
    if (n && books) n.textContent = books.length || "";
    if (shown()) redraw();
    // The site is still asking the libraries: look again in half a minute, for about half an hour at most.
    clearTimeout(again);
    if (libs?.unchecked && tries < 60) again = setTimeout(() => shown() && (tries++, load(true)), 30000);
  }
  const enter = () => ((tries = 0), (wq = ""), (counted = false), window.Shelves?.ensure(), load());

  // Where one's own file or the free shelf's is, by its file name.
  const inLib = (name) => name && window.Shell.books().find((b) => b.path === name);
  const mineOf = (b) => inLib(b.mine) || (b.mine ? { path: b.mine } : null);
  const readNow = (b) => (b.mine ? b.mine : b.free || "");
  const link = (url, text, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" target="_blank" rel="noopener" data-act="want-out">${text}</a>`;
  const shop = (s) => link(s.url, esc(s.shop)) + ((t) => (t ? ` <span class="r-want-m">${esc(t)}</span>` : ""))([s.price, s.note].filter(Boolean).join(", "));
  const uah = (p) => Number(String(p || "").replace(/[^\d]/g, "")) || 0;

  // Under the cover only a price (Max 2026-11-25, bot №49, variant B: «каша з підписами»): the lowest in a Ukrainian
  // shop, the book's own or its other language's (original, translation), no «від», «укр.», shop names; none = nothing.
  // Rental, free texts and shops abroad are in the card.
  function how(b) {
    const ps = [b, ...(b.other || [])].flatMap((v) => (v.get || []).flatMap((g) => g.shops)).map((s) => uah(s.price)).filter(Boolean);
    return ps.length ? `${Math.min(...ps)} ₴` : "";
  }
  const group = (b) => (readNow(b) ? "now" : b.get?.length || b.rent || b.online?.length || b.abroad?.length || b.other?.length ? "buy" : "none");
  const LANG = { uk: "Українською", en: "Англійською", "": "В оригіналі" };

  function tile(b, i, cap, act = "want-lib-card") {
    const path = readNow(b);
    const foot = cap != null ? `<span class="r-want-h r-want-lib">${esc(cap)}</span>` : path
      ? `<span class="r-want-h"><button type="button" class="r-want-go" data-open="${esc(path)}" data-act="${b.mine ? "want-mine" : "want-free"}">Читати</button></span>`
      : how(b) ? `<span class="r-want-h">${esc(how(b))}</span>` : "";
    return `<div class="r-want-b">
      <button type="button" class="r-want-c" data-act="${cap != null ? act : "want-card"}" data-want="${i}">${window.Shell.rcover({ title: b.title, authors: [b.author] }, b.cover || null)}<span class="r-want-t">${esc(b.title)}</span></button>
      ${foot}</div>`;
  }

  // The search: what was typed (kept across redraws), the catalog's answers by query, the pages put on the list here.
  let wq = "";
  const found = new Map(); // query -> { books } | "…" | { error }
  const added = new Set();
  const nq = (s) => String(s || "").toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\s+/g, " ").trim();
  let shelf = {}; // book page -> status on the site shelf other than «Хочу прочитати»
  const SHELF = { read: "Уже прочитано", reading: "Читаєте", abandoned: "Кинули читати" };
  const onList = (href) => added.has(href) || !!books?.some((b) => b.href === href);
  const field = () => `<label class="r-search r-add-search r-want-q"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg><input id="r-wq" type="search" placeholder="Додати: назва або автор" autocomplete="off" enterkeyhint="search" value="${esc(wq)}" /></label>`;
  function catRows(q) {
    const cat = found.get(nq(q));
    if (nq(q).length < 2) return "";
    if (cat === "…" || cat == null) return `<p class="r-empty">${SPIN}Шукаю…</p>`;
    if (cat.error) return `<p class="r-empty">${navigator.onLine ? "Каталог зараз не відповідає." : "Немає з'єднання."}</p>`;
    if (!cat.books.length) return `<p class="r-empty">Нічого не знайшлося. ${link(`https://chytai.org.ua/search?q=${encodeURIComponent(q.trim())}`, "Шукати на chytai.org.ua ↗", "r-link")}</p>`;
    return `<div class="r-frows">${cat.books.map((b, i) => `<div class="r-frow r-frow-cat">${link(b.href, window.Shell.rcover({ title: b.title, authors: [b.author] }, b.cover || null), "r-frow-c")}
      <a class="r-frow-x" href="${esc(b.href)}" target="_blank" rel="noopener" data-act="want-find-page"><span class="r-frow-t">${esc(b.title)}</span><span class="r-frow-a">${esc([b.author, b.year].filter(Boolean).join(" · "))}</span></a>
      ${onList(b.href) ? `<span class="r-frow-go done">✓ У списку</span>` : SHELF[shelf[b.href]] ? `<span class="r-frow-go done">${SHELF[shelf[b.href]]}</span>` : `<button type="button" class="r-frow-go" data-wadd="${i}" data-act="want-find-add">Хочу прочитати</button>`}</div>`).join("")}</div>`;
  }
  function foundHtml(head, grid) {
    const w = nq(wq);
    if (!w) return "";
    const mine = (books || []).map((b, i) => [b, i]).filter(([b]) => w.split(" ").every((x) => nq(`${b.title} ${b.author}`).includes(x)));
    const cat = found.get(w);
    return (mine.length ? head("Уже у списку", mine.length) + grid(mine) : "") + `<div class="r-sec-head"><h2>Каталог Chytai${cat?.books?.length ? ` · ${cat.books.length}` : ""}</h2></div>${catRows(wq)}`;
  }
  const headH = (t, n) => `<div class="r-sec-head"><h2>${t} · ${n}</h2></div>`;
  const gridH = (list) => `<div class="r-want-g">${list.map(([b, i]) => tile(b, i)).join("")}</div>`;
  // Only the results change while typing: the field keeps its focus and the keyboard stays up.
  function drawFound() {
    const f = document.querySelector("#r-wfound");
    if (!f) return;
    f.innerHTML = foundHtml(headH, gridH);
    const shelf = document.querySelector(".r-want-shelf");
    if (shelf) shelf.hidden = !!nq(wq);
  }
  // A whole redraw (the list came again) puts the focus and the caret back into the field.
  function redraw() {
    const el = document.activeElement?.id === "r-wq" ? document.activeElement : null;
    const at = el ? [el.selectionStart, el.selectionEnd] : null;
    window.Shell.rerender();
    const n = at && document.querySelector("#r-wq");
    if (n) n.focus({ preventScroll: true }), n.setSelectionRange(...at);
  }
  let timer = 0;
  let counted = false;
  function search(q) {
    wq = q;
    clearTimeout(timer);
    drawFound();
    const k = nq(q);
    if (k.length < 2 || (found.has(k) && !found.get(k).error)) return;
    timer = setTimeout(() => {
      // Once a visit to the page: counted, and the rest of the site shelf asked (what is read or being read).
      if (!counted) (counted = true), window.ReadingTime?.count("want-find"), window.reader.wantShelf?.().then((d) => d?.shelf && ((shelf = d.shelf), drawFound()));
      found.set(k, "…");
      drawFound();
      window.reader
        .catalogFind(q.trim())
        .then((d) => found.set(k, { books: d.books || [] }))
        .catch(() => found.set(k, { error: true }))
        .finally(() => {
          if (found.size > 100) found.delete(found.keys().next().value);
          if (nq(wq) === k) drawFound();
        });
    }, 250);
  }
  async function addBook(btn) {
    const b = found.get(nq(wq))?.books?.[Number(btn.dataset.wadd)];
    if (!b) return;
    btn.disabled = true;
    let r;
    try {
      r = await window.reader.mentionWant(b.href);
    } catch (err) {
      btn.disabled = false;
      return window.showNotice?.(err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло.", false);
    }
    // A book already on the shelf keeps its status on the site: say which (read, reading, dropped).
    const was = SHELF[r?.status];
    if (was) return (shelf[b.href] = r.status), (btn.outerHTML = `<span class="r-frow-go done">${was}</span>`);
    added.add(b.href);
    btn.outerHTML = `<span class="r-frow-go done">✓ У списку</span>`;
    load(true);
  }

  function html() {
    const top = `<section class="r-want"><h1 class="r-jh">Хочу прочитати</h1>`;
    if (!books) return `${top}<p class="r-empty">${failed ? "Без мережі список не показати." : `${SPIN}Збираємо…`}</p></section>`;
    const find = `${field()}<div id="r-wfound">${foundHtml(headH, gridH)}</div>`;
    if (!books.length) return `${top}<p class="r-want-p">Тут будуть книжки з вашого «Хочу прочитати» на ${link("https://chytai.org.ua/me", "chytai.org.ua ↗")}</p>${find}</section>`;
    // In the shelf's order inside each part, one's own files before the free shelf.
    const parts = { now: [], buy: [], none: [] };
    books.forEach((b, i) => parts[group(b)].push([b, i]));
    parts.now.sort((x, y) => (y[0].mine ? 1 : 0) - (x[0].mine ? 1 : 0) || x[1] - y[1]);
    const grid = (list) => `<div class="r-want-g">${list.map(([b, i]) => tile(b, i)).join("")}</div>`;
    const head = (t, n, aside = "") => `<div class="r-sec-head"><h2>${t} · ${n}</h2>${aside}</div>`;
    const none = parts.none.length ? head("Поки немає", parts.none.length) + grid(parts.none) : "";
    return `${top}<p class="r-want-p">${books.length} ${plural(books.length, "книжка", "книжки", "книжок")} з вашої полиці на chytai.org.ua</p>
      ${find}<div class="r-want-shelf"${nq(wq) ? " hidden" : ""}>
      ${parts.now.length ? head("Можна читати зараз", parts.now.length) + grid(parts.now) : ""}
      ${friendsPart(head)}
      ${shopsPart(head)}
      ${parts.buy.length ? head("Купити або взяти напрокат", parts.buy.length) + grid(parts.buy) : ""}
      ${libsPart(head, grid)}${none}</div></section>`;
  }

  // «Полиці друзів» (Max 2026-11-28, variant A of canvas H7RtPE5ytNgCN2uEt22xD7; shelves.js): the books on the shelves
  // the reader added by friends' links (the server's `shelves` per book), whose shelf under the cover. Shown once the
  // reader has a friend's shelf; none = no block (the panel's «Полиці» is where one starts).
  function friendsPart(head) {
    const fr = window.Shelves?.follows() || [];
    const have = books.map((b, i) => [b, i]).filter(([b]) => !readNow(b) && b.shelves?.length);
    if (!have.length && !fr.length) return "";
    const aside = `<button type="button" class="r-link r-want-fold" data-sh="list" data-act="want-shelves">Полиці</button>`;
    const names = [...new Set(fr.map(window.Shelves.label))].join(" · ");
    return `<div class="r-want-libs">${head("Полиці друзів", have.length, aside)}
      <p class="r-want-p">${esc(names)}${have.length ? "" : `${names ? "<br>" : ""}Цих книжок на їхніх полицях немає.`}</p>
      ${have.length ? `<div class="r-want-g">${have.map(([b, i]) => tile(b, i, window.Shelves.cap(b), "want-shelf-card")).join("")}</div>` : ""}</div>`;
  }

  // «Мої книгарні»: a book counts when it or its other version (original, translation) is in stock in a picked shop;
  // under the cover the lowest such price, and the shop's name when the reader picked several.
  const inMine = (b) =>
    [b, ...(b.other || [])].flatMap((v) => myShops.filter((n) => v.stock?.[n]).map((n) => [n, v.stock[n][0] || Infinity])).sort((x, y) => x[1] - y[1]);
  function shopsPart(head) {
    const change = `<button type="button" class="r-link r-want-fold" data-act="want-shops">Змінити</button>`;
    if (!myShops.length)
      return `<div class="r-want-libs"><div class="r-sec-head"><h2>Мої книгарні</h2></div>
        <p class="r-want-p">Оберіть до п'яти книгарень, і тут будуть книжки, які в них є зараз.</p>
        <p class="r-want-p"><button type="button" class="r-pill-line" data-act="want-shops">Обрати книгарню</button></p></div>`;
    const have = books.map((b, i) => [b, i]).filter(([b]) => !readNow(b) && inMine(b).length);
    const cap = (b) => ((t) => (Number.isFinite(t[1]) ? `${t[1]} ₴` : "є") + (myShops.length > 1 ? ` · ${t[0]}` : ""))(inMine(b)[0]);
    return `<div class="r-want-libs">${head("Мої книгарні", have.length, change)}
      <p class="r-want-p">${esc(myShops.join(", "))}${have.length ? "" : "<br>Зараз цих книжок там немає."}</p>
      ${have.length ? `<div class="r-want-g">${have.map(([b, i]) => tile(b, i, cap(b), "want-shop-card")).join("")}</div>` : ""}</div>`;
  }

  // «Бібліотеки»: a branch's short name («Бібліотека ім. А. Головка» → «ім. А. Головка», no address); how it holds
  // the book: on the shelf now, there (Kyiv's branches don't say whether it is lent), every copy lent.
  const short = (n) => n.replace(/\s*\(.*\)\s*$/, "").replace(/^Бібліотека(-філія)?\s+/, "").trim() || n;
  const STATE = { on: "на полиці", held: "є", out: "усі видані" };
  const RANK = { on: 0, held: 1, out: 2 };
  const best = (b) => [...b.lib].sort((x, y) => RANK[x.state] - RANK[y.state])[0];
  function libsPart(head, grid) {
    const change = `<button type="button" class="r-link r-want-fold" data-act="want-libs">Змінити</button>`;
    if (!picks.length)
      return `<div class="r-want-libs"><div class="r-sec-head"><h2>Бібліотеки</h2></div>
        <p class="r-want-p">Оберіть свою бібліотеку, і тут будуть книжки, які в ній є. Поки Київ, Черкаси й Ужгород.</p>
        <p class="r-want-p"><button type="button" class="r-pill-line" data-act="want-libs">Обрати бібліотеку</button></p></div>`;
    const have = books.map((b, i) => [b, i]).filter(([b]) => b.lib?.length);
    have.sort((x, y) => RANK[best(x[0]).state] - RANK[best(y[0]).state] || x[1] - y[1]);
    const cap = (b) => {
      const t = best(b);
      if (t.state === "out") return STATE.out;
      return picks.length > 1 ? short(t.branch) + (b.lib.length > 1 ? ` +${b.lib.length - 1}` : "") : STATE[t.state];
    };
    const names = picks.map((p) => short(p.branch)).join(", ");
    const wait = libBusy ? `${SPIN}Дивимося в бібліотеках…` : libs?.unchecked ? `Ще перевіряємо ${libs.unchecked} ${plural(libs.unchecked, "книжку", "книжки", "книжок")}, список доповниться.` : "";
    const empty = !have.length && !libBusy && !libs?.unchecked ? "Цих книжок у ваших бібліотеках немає." : "";
    return `<div class="r-want-libs">${head("Бібліотеки", libBusy ? "…" : have.length, change)}
      <p class="r-want-p">${esc(names)}${wait ? `<br>${wait}` : ""}${empty ? `<br>${empty}` : ""}</p>
      ${have.length && !libBusy ? `<div class="r-want-g">${have.map(([b, i]) => tile(b, i, cap(b))).join("")}</div>` : ""}</div>`;
  }

  // The picker: city tabs, a search when the city has many, one checkbox a branch, the picked ones first.
  let all = null; // [{ id, city, name, branches: [{ name }] }]
  let chosen = [];
  let city = "";
  let q = "";
  const dlg = () => document.querySelector("#libs-dialog");
  const isOn = (lib, name) => chosen.some((p) => p.lib === lib && p.branch === name);
  let mode = "libs"; // the dialog picks library branches or shops
  async function pick() {
    mode = "libs";
    dlg().querySelector("h2").textContent = "Мої бібліотеки";
    chosen = picks.map((p) => ({ ...p }));
    q = "";
    const d = dlg();
    d.querySelector("#lb-sub").textContent = "До п'яти бібліотек. Покажемо, які книжки з вашого списку там є.";
    d.querySelector("#lb-body").innerHTML = `<p class="lb-note">${SPIN}</p>`;
    d.showModal();
    if (!all) all = (await window.reader.wantLibraries?.())?.libs?.filter((l) => l.branches.length).sort((x, y) => y.branches.length - x.branches.length) || null;
    if (!all) return (d.querySelector("#lb-body").innerHTML = `<p class="lb-note">Без мережі список не показати.</p>`);
    city = all.find((l) => chosen.some((p) => p.lib === l.id))?.id || all[0].id;
    pickerHtml();
  }
  function pickerHtml() {
    const lib = all.find((l) => l.id === city);
    const search = lib.branches.length > 12 ? `<input class="lb-q" type="search" placeholder="Назва бібліотеки" autocomplete="off" enterkeyhint="search" value="${esc(q)}" />` : "";
    dlg().querySelector("#lb-body").innerHTML = `<div class="r-tabs"></div>${search}<ul class="lb-list"></ul><p class="lb-note lb-n"></p>`;
    listHtml(true);
  }
  function tabsHtml() {
    dlg().querySelector(".r-tabs").innerHTML = all.map((l) => {
      const n = chosen.filter((p) => p.lib === l.id).length;
      return `<button type="button" class="${l.id === city ? "on" : ""}" data-act="want-lib-city" data-city="${esc(l.id)}">${esc(l.city)}${n ? ` <i>${n}</i>` : ""}</button>`;
    }).join("");
  }
  // The picked ones first when the list opens; a tick doesn't move a row from under the finger.
  let order = [];
  function listHtml(sort) {
    const lib = all.find((l) => l.id === city);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = lib.branches.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
    if (sort) order = [...lib.branches].sort((x, y) => isOn(lib.id, y.name) - isOn(lib.id, x.name)).map((b) => b.name);
    list.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
    const full = chosen.length >= 5;
    const d = dlg();
    d.querySelector(".lb-list").innerHTML = list.length
      ? list.map((b) => {
        const on = isOn(lib.id, b.name);
        return `<li><label class="${full && !on ? "off" : ""}" data-act="want-lib-pick"><input type="checkbox" data-branch="${esc(b.name)}"${on ? " checked" : ""}${full && !on ? " disabled" : ""} />${esc(b.name)}</label></li>`;
      }).join("")
      : `<li class="lb-note">Такої немає.</li>`;
    tabsHtml();
    d.querySelector(".lb-n").textContent = chosen.length ? `Обрано ${chosen.length} з 5.` : "";
  }
  // The shops' picker in the same dialog: tabs «Книгарні» / «Видавництва» (a publisher's own shop), every shop that has
  // a book of the list in stock now with how many, the picked ones first; 3 at most.
  let shopsChosen = [];
  let shopTab = "shop";
  const FMT = { "e-book": "електронні", аудіо: "аудіо", папір: "папір" };
  function pickShops() {
    mode = "shops";
    shopsChosen = [...myShops];
    shopTab = myShops.length && Object.keys(shopKinds).length && myShops.every((n) => shopKinds[n]?.kind === "publisher") ? "publisher" : "shop";
    const d = dlg();
    d.querySelector("h2").textContent = "Мої книгарні";
    d.querySelector("#lb-sub").textContent = "До п'яти. Покажемо, які книжки з вашого списку там є зараз.";
    shopsHtml(true);
    d.showModal();
  }
  let shopOrder = [];
  function shopsHtml(sort) {
    const n = (name) => (books || []).filter((b) => [b, ...(b.other || [])].some((v) => v.stock?.[name])).length;
    const names = [...new Set([...Object.keys(shopKinds), ...shopsChosen])];
    const kind = (name) => shopKinds[name]?.kind || "shop";
    const tabs = ["shop", "publisher"].filter((t) => t === "shop" || names.some((x) => kind(x) === t));
    if (!tabs.includes(shopTab)) shopTab = "shop";
    const list = names.filter((x) => kind(x) === shopTab);
    if (sort) shopOrder = [...list].sort((x, y) => shopsChosen.includes(y) - shopsChosen.includes(x) || n(y) - n(x) || x.localeCompare(y, "uk"));
    list.sort((x, y) => shopOrder.indexOf(x) - shopOrder.indexOf(y));
    const full = shopsChosen.length >= SHOPS_MAX;
    const tabsHtml = tabs.length > 1 ? `<div class="r-tabs">${tabs.map((t) => {
      const c = shopsChosen.filter((x) => kind(x) === t).length;
      return `<button type="button" class="${t === shopTab ? "on" : ""}" data-act="want-shop-tab" data-stab="${t}">${t === "shop" ? "Книгарні" : "Видавництва"}${c ? ` <i>${c}</i>` : ""}</button>`;
    }).join("")}</div>` : "";
    const fmt = (name) => ((f) => (f.length === 1 ? ` <span class="lb-kind">${FMT[f[0]]}</span>` : ""))(shopKinds[name]?.formats || []);
    const rows = list.length
      ? list.map((x) => {
        const on = shopsChosen.includes(x);
        const k = n(x);
        return `<li><label class="${full && !on ? "off" : ""}" data-act="want-shop-pick"><input type="checkbox" data-shop="${esc(x)}"${on ? " checked" : ""}${full && !on ? " disabled" : ""} />${esc(x)}${fmt(x)}<small>${k ? `${k} з вашого списку` : "зараз нічого"}</small></label></li>`;
      }).join("")
      : `<li class="lb-note">Поки жодна з цих книгарень не має книжок з вашого списку.</li>`;
    const note = shopsChosen.length ? `Обрано ${shopsChosen.length} з ${SHOPS_MAX}.` : "Yakaboo, «Є» й Readeat поки не кажуть, що в них є.";
    dlg().querySelector("#lb-body").innerHTML = `${tabsHtml}<ul class="lb-list">${rows}</ul><p class="lb-note lb-n">${note}</p>`;
  }

  function plural(n, one, few, many) {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  }

  // Where to get one version of the book: one line a format, then BookFlow and the shops abroad.
  function lines(v, abroadLabel) {
    const out = [];
    for (const g of v.get || []) {
      // The reader's own shops first in their format, even when they are not among the two cheapest.
      const mine = myShops.filter((n) => v.stock?.[n]?.[2] === g.kind).map((n) => ({ shop: n, price: v.stock[n][0] ? `${v.stock[n][0]} ₴` : "", url: v.stock[n][1], mine: true }));
      const list = mine.length ? [...mine, ...g.shops.filter((x) => !mine.some((m) => m.shop === x.shop))].slice(0, Math.max(2, mine.length + 1)) : g.shops;
      out.push([KIND[g.kind] || g.kind, list.map((x) => (x.mine ? `<b class="r-want-mine">${shop(x)}</b>` : shop(x))).join(` <span class="r-want-m">·</span> `)]);
    }
    // A picked shop with the book in a format the list doesn't show yet (rare: the book's get is cut to in-stock rows).
    for (const n of myShops) if (v.stock?.[n] && !(v.get || []).some((g) => g.kind === v.stock[n][2])) out.unshift([KIND[v.stock[n][2]] || v.stock[n][2], `<b class="r-want-mine">${shop({ shop: n, price: v.stock[n][0] ? `${v.stock[n][0]} ₴` : "", url: v.stock[n][1] })}</b>`]);
    if (v.rent) out.push(["Напрокат", `${link(v.rent.url, "BookFlow")}<span class="r-want-m">, ${v.rent.free ? "є вільна" : "зараз усі в читачів"}${v.rent.price ? `, ${v.rent.price} ₴` : ""}</span>`]);
    if (v.abroad?.length) out.push([abroadLabel, v.abroad.map((l) => link(l.url, `${esc(l.label)} ↗`)).join(` <span class="r-want-m">·</span> `)]);
    return out.map(([k, x]) => `<div><span class="r-want-k">${esc(k)}</span><span>${x}</span></div>`).join("");
  }

  // «Читати» and where to get it (the book, then its original or translation), as HTML for a card; «Згадані книжки»
  // (mentions.js) shows the same on a mentioned book's card.
  function where(b) {
    const mine = mineOf(b);
    const path = readNow(b);
    const lib = b.lib?.length ? `<div><span class="r-want-k">Бібліотека</span><span>${[...b.lib].sort((x, y) => RANK[x.state] - RANK[y.state]).map((l) => `${link(l.url, esc(l.branch.replace(/\s*\(.*\)\s*$/, "")))}<span class="r-want-m">, ${STATE[l.state]}</span>`).join("<br>")}</span></div>` : "";
    const own = (window.Shelves?.cardRow(b) || "") + lib + (b.online?.length ? `<div><span class="r-want-k">Онлайн</span><span>${b.online.map((l) => link(l.url, `${esc(l.label)} ↗`)).join(` <span class="r-want-m">·</span> `)}</span></div>` : "") + lines(b, b.lang === "en" ? "Англійською" : "Інше");
    // Max 2026-11-24: «показувати де версію англ можна взяти… навіть якщо є, іноді я свідомо хочу читати в оригіналі».
    // Only the language over the other version's shops, not its title (Max: «тільки конфьюзить»); links alone = one row.
    const others = (b.other || []).map((v) => (v.get?.length || v.rent ? `<div class="r-want-v"><span>${LANG[v.lang] ?? LANG[""]}</span></div>${lines(v, "Де знайти")}` : lines(v, LANG[v.lang] ?? LANG[""]))).join("");
    const go = path ? `${b.mine ? `<p class="r-want-none">Файл уже у ваших книжках.</p>` : ""}<button type="button" class="r-pill pf-go" data-want-open="${esc(mine?.path || path)}" data-act="${b.mine ? "want-mine" : "want-free"}">${b.mine ? "Читати" : "Почати читати"}</button>` : "";
    const where = own || others
      ? `<h3 class="pf-wh">Де взяти</h3><div class="r-want-where">${own}${others}</div>`
      : path ? "" : `<p class="r-want-none">У магазинах зараз немає.</p>`;
    return go + where;
  }
  // The card: «Читати», where to get it, then the card's «Про книжку».
  function card(b) {
    // No «Додати в мої книжки» here (Max 2026-11-24, bot №52): the book is on one's list already.
    window.Paper.card(
      { title: b.title, author: b.author, cover: b.cover || "", href: b.href, year: b.year },
      { top: where(b), noAdd: true, foot: `<p class="pf-page">${link(b.href, "Сторінка книжки на Chytai ↗")}</p><p class="mn-dropp"><button type="button" class="r-link mn-drop" data-want-drop="${esc(b.href)}" data-act="want-drop">Прибрати з «Хочу прочитати»</button></p>` },
    );
  }
  // «Прибрати з «Хочу прочитати»» (Max 2026-11-26, bot №63): off the site's shelf, then the list again.
  document.querySelector("#paper-found").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-want-drop]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await window.reader.mentionWant(btn.dataset.wantDrop, true);
    } catch (err) {
      btn.disabled = false;
      return window.showNotice?.(err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло.", false);
    }
    const href = btn.dataset.wantDrop;
    document.querySelector("#paper-found").close();
    if (books) books = books.filter((x) => x.href !== href);
    const n = document.querySelector("#r-n-want");
    if (n && books) n.textContent = books.length || "";
    if (shown()) redraw();
  });

  const d = dlg();
  d.addEventListener("click", (e) => {
    const s = e.target.closest("[data-stab]");
    if (s) return (shopTab = s.dataset.stab), shopsHtml(true);
    const t = e.target.closest("[data-city]");
    if (t) return (city = t.dataset.city), (q = ""), pickerHtml();
  });
  d.addEventListener("change", (e) => {
    const sb = e.target.closest("[data-shop]");
    if (sb) {
      const name = sb.dataset.shop;
      shopsChosen = shopsChosen.includes(name) ? shopsChosen.filter((x) => x !== name) : [...shopsChosen, name].slice(0, SHOPS_MAX);
      return shopsHtml(false);
    }
    const box = e.target.closest("[data-branch]");
    if (!box) return;
    const name = box.dataset.branch;
    chosen = isOn(city, name) ? chosen.filter((p) => !(p.lib === city && p.branch === name)) : [...chosen, { lib: city, branch: name }].slice(0, 5);
    listHtml(false);
  });
  d.addEventListener("input", (e) => {
    if (!e.target.matches(".lb-q")) return;
    q = e.target.value;
    listHtml(true);
  });
  // Closing keeps the choice (Готово, Esc, a tap outside alike): to the account, then the list asks the site again.
  d.addEventListener("close", async () => {
    if (mode === "shops") {
      if (JSON.stringify(shopsChosen) === JSON.stringify(myShops)) return;
      myShops = shopsChosen;
      if (shown()) redraw();
      try {
        await window.reader.setSettings({ shops: myShops });
      } catch {}
      return;
    }
    if (JSON.stringify(chosen) === JSON.stringify(picks)) return;
    picks = chosen;
    libBusy = picks.length > 0;
    libs = null;
    tries = 0;
    if (shown()) redraw();
    try {
      await window.reader.setSettings({ libraries: picks });
    } catch {}
    load(true);
  });
  // A tap on the backdrop closes it, as «Про книжку».
  d.addEventListener("click", (e) => {
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
  });

  document.querySelector("#shell").addEventListener("input", (e) => e.target.id === "r-wq" && search(e.target.value));
  document.querySelector("#shell").addEventListener("keydown", (e) => {
    if (e.target.id !== "r-wq") return;
    if (e.key === "Enter") e.target.blur(); // the keyboard goes, the results stay
    if (e.key === "Escape" && e.target.value) e.preventDefault(), (e.target.value = ""), search("");
  });
  document.querySelector("#shell").addEventListener("click", (e) => {
    if (!shown()) return;
    const a = e.target.closest("[data-wadd]");
    if (a) return addBook(a);
    if (e.target.closest("[data-act='want-libs']")) return pick();
    if (e.target.closest("[data-act='want-shops']")) return pickShops();
    const el = e.target.closest("[data-want]");
    const b = el && books?.[Number(el.dataset.want)];
    if (b) card(b);
  });
  document.querySelector("#paper-found").addEventListener("click", (e) => {
    const el = e.target.closest("[data-want-open]");
    if (!el) return;
    e.currentTarget.close();
    window.Shell.open(el.dataset.wantOpen);
  });

  // Asked once a few seconds after the page loads, for the panel's count (and so the page opens at once); the reader's
  // server keeps the answer a minute, the site builds it from memory.
  setTimeout(() => !document.body.classList.contains("guest") && !books && window.reader?.want && load(), 4000);

  window.Want = { html, enter, where, books: () => books || [], refresh: () => load() };
})();
