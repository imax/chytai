// «Хочу прочитати» (Max 2026-11-24, in place of Scratchpad): the books on the reader's «Хочу прочитати» shelf on
// chytai.org.ua as a shelf of covers (Max chose design B of canvas C4zbe7sBdsPD1z41gChjEj): «Можна читати зараз»
// (one's own file, a free-shelf book), «Купити або взяти» (the shops, BookFlow, free texts online) and «Поки ніде»,
// folded. Under a cover one word on how to get it («Читати», «від 90 ₴»); a tap on the cover = the book's card
// (paper.js `Paper.card`): «Читати», «Де взяти» (one line a format, as the book page's «Де взяти»), «Про книжку»
// and the book's page. GET /api/want (server/index.js → the site's /api/reader-want). A page in the panel after
// «Мої книжки» (home.js page «want»). Taps count by data-act (reading-time.js): act-want-*.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const KIND = { "e-book": "E-book", папір: "Папір", аудіо: "Аудіо" };
  const SPIN = `<span class="spinner"></span>`;

  let books = null; // the last answer
  let asking = false;
  let failed = false;
  let noneOpen = false; // «Поки ніде» unfolded

  const shown = () => document.querySelector("#shell")?.dataset.page === "want";

  async function load() {
    if (asking) return;
    asking = true;
    const r = await window.reader.want?.();
    asking = false;
    if (r?.books) (books = r.books), (failed = false);
    else failed = !books;
    if (shown()) window.Shell.rerender();
  }

  // Where one's own file or the free shelf's is, by its file name.
  const inLib = (name) => name && window.Shell.books().find((b) => b.path === name);
  const mineOf = (b) => inLib(b.mine) || (b.mine ? { path: b.mine } : null);
  const readNow = (b) => (b.mine ? b.mine : b.free || "");
  const link = (url, text, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" target="_blank" rel="noopener" data-act="want-out">${text}</a>`;
  const shop = (s) => link(s.url, esc(s.shop)) + ((t) => (t ? ` <span class="r-want-m">${esc(t)}</span>` : ""))([s.price, s.note].filter(Boolean).join(", "));
  const uah = (p) => Number(String(p || "").replace(/[^\d]/g, "")) || 0;

  // One word under the cover: how to get it. A price: the cheapest shop's, «від» when there are more.
  function how(b) {
    const shops = (b.get || []).flatMap((g) => g.shops).filter((s) => uah(s.price));
    if (shops.length) {
      const low = Math.min(...shops.map((s) => uah(s.price)));
      return `${shops.length > 1 ? "від " : ""}${low} ₴`;
    }
    if (b.rent) return `BookFlow${b.rent.price ? ` ${b.rent.price} ₴` : ""}`;
    if (b.online?.length) return "Безкоштовно онлайн";
    return "";
  }
  const group = (b) => (readNow(b) ? "now" : b.get?.length || b.rent || b.online?.length ? "buy" : "none");

  function tile(b, i) {
    const path = readNow(b);
    const foot = path
      ? `<span class="r-want-h"><button type="button" class="r-want-go" data-open="${esc(path)}" data-act="${b.mine ? "want-mine" : "want-free"}">Читати</button></span>`
      : `<span class="r-want-h">${esc(how(b))}</span>`;
    return `<div class="r-want-b">
      <button type="button" class="r-want-c" data-act="want-card" data-want="${i}">${window.Shell.rcover({ title: b.title, authors: [b.author] }, b.cover || null)}<span class="r-want-t">${esc(b.title)}</span></button>
      ${foot}</div>`;
  }

  function html() {
    const top = `<section class="r-want"><h1 class="r-jh">Хочу прочитати</h1>`;
    if (!books) return `${top}<p class="r-empty">${failed ? "Без мережі список не показати." : `${SPIN}Збираємо…`}</p></section>`;
    if (!books.length) return `${top}<p class="r-want-p">Тут будуть книжки з вашого «Хочу прочитати» на ${link("https://chytai.org.ua/me", "chytai.org.ua ↗")}</p></section>`;
    // In the shelf's order inside each part, one's own files before the free shelf.
    const parts = { now: [], buy: [], none: [] };
    books.forEach((b, i) => parts[group(b)].push([b, i]));
    parts.now.sort((x, y) => (y[0].mine ? 1 : 0) - (x[0].mine ? 1 : 0) || x[1] - y[1]);
    const grid = (list) => `<div class="r-want-g">${list.map(([b, i]) => tile(b, i)).join("")}</div>`;
    const head = (t, n, aside = "") => `<div class="r-sec-head"><h2>${t} · ${n}</h2>${aside}</div>`;
    const none = parts.none.length
      ? `${head("Поки ніде", parts.none.length, `<button type="button" class="r-link r-want-fold" data-act="want-none">${noneOpen ? "Згорнути" : "Показати"}</button>`)}${noneOpen ? grid(parts.none) : `<p class="r-want-p">${notSold(parts.none)}</p>`}`
      : "";
    return `${top}<p class="r-want-p">${books.length} ${plural(books.length, "книжка", "книжки", "книжок")} з вашої полиці на chytai.org.ua</p>
      ${parts.now.length ? head("Можна читати зараз", parts.now.length) + grid(parts.now) : ""}
      ${parts.buy.length ? head("Купити або взяти", parts.buy.length) + grid(parts.buy) : ""}
      ${none}</section>`;
  }
  // The folded «Поки ніде»: why, when most of them are in English (no Ukrainian edition to buy).
  function notSold(list) {
    const latin = list.filter(([b]) => !/[а-яіїєґ]/i.test(b.title)).length;
    return latin * 2 > list.length ? "Здебільшого англійською: українського видання в магазинах немає." : "Зараз немає в магазинах.";
  }
  function plural(n, one, few, many) {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  }

  // The card: «Читати», where to get it, then the card's own «Про книжку».
  function card(b) {
    const mine = mineOf(b);
    const path = readNow(b);
    const lines = [];
    if (b.online?.length) lines.push(["Онлайн", b.online.map((l) => link(l.url, `${esc(l.label)} ↗`)).join(` <span class="r-want-m">·</span> `)]);
    for (const g of b.get || []) lines.push([KIND[g.kind] || g.kind, g.shops.map(shop).join(` <span class="r-want-m">·</span> `)]);
    if (b.rent) lines.push(["Напрокат", `${link(b.rent.url, "BookFlow")}<span class="r-want-m">, ${b.rent.free ? "є вільна" : "зараз усі в читачів"}${b.rent.price ? `, ${b.rent.price} ₴` : ""}</span>`]);
    const go = path ? `${b.mine ? `<p class="r-want-none">Файл уже у ваших книжках.</p>` : ""}<button type="button" class="r-pill pf-go" data-want-open="${esc(mine?.path || path)}" data-act="${b.mine ? "want-mine" : "want-free"}">${b.mine ? "Читати" : "Читати безкоштовно"}</button>` : "";
    const where = lines.length
      ? `<h3 class="pf-wh">Де взяти</h3><div class="r-want-where">${lines.map(([k, v]) => `<div><span class="r-want-k">${esc(k)}</span><span>${v}</span></div>`).join("")}</div>`
      : path ? "" : `<p class="r-want-none">У магазинах зараз немає.</p>`;
    window.Paper.card(
      { title: b.title, author: b.author, cover: b.cover || "", href: b.href, year: b.year },
      { top: go + where, noAdd: !!path, foot: `<p class="pf-page">${link(b.href, "Сторінка книжки на Chytai ↗")}</p>` },
    );
  }

  document.querySelector("#shell").addEventListener("click", (e) => {
    if (!shown()) return;
    if (e.target.closest("[data-act='want-none']")) return (noneOpen = !noneOpen), window.Shell.rerender();
    const el = e.target.closest("[data-act='want-card']");
    const b = el && books?.[Number(el.dataset.want)];
    if (b) card(b);
  });
  document.querySelector("#paper-found").addEventListener("click", (e) => {
    const el = e.target.closest("[data-want-open]");
    if (!el) return;
    e.currentTarget.close();
    window.Shell.open(el.dataset.wantOpen);
  });

  window.Want = { html, enter: load };
})();
