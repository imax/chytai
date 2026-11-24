// «Хочу прочитати» (Max 2026-11-24, in place of Scratchpad): the books on the reader's «Хочу прочитати» shelf on
// chytai.org.ua, each with where to get it. One's own file of it opens here («Відкрити»), a free-shelf book too
// («Читати безкоштовно»); then free texts online, the shops (one line a format, as the book page's «Де взяти») and
// BookFlow. A tap on a cover = the cover's card (paper.js: «Про книжку», «Додати» as a paper book). GET /api/want
// (server/index.js → the site's /api/reader-want). A page in the panel under «Статистика» (home.js page «want»).
// Taps count by data-act (reading-time.js): act-want-*.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const KIND = { "e-book": "E-book", папір: "Папір", аудіо: "Аудіо" };
  const SPIN = `<span class="spinner"></span>`;

  let books = null; // the last answer
  let asking = false;
  let failed = false;

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
  const link = (url, text, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" target="_blank" rel="noopener" data-act="want-out">${text}</a>`;
  const shop = (s) => link(s.url, esc(s.shop)) + ((t) => (t ? ` <span class="r-want-m">${esc(t)}</span>` : ""))([s.price, s.note].filter(Boolean).join(", "));

  function row(b, i) {
    const mine = inLib(b.mine) || (b.mine ? { path: b.mine } : null);
    const lines = [];
    if (b.online?.length) lines.push(["Безкоштовно", b.online.map((l) => link(l.url, `${esc(l.label)} ↗`)).join(" · ")]);
    for (const g of b.get || []) lines.push([KIND[g.kind] || g.kind, g.shops.map(shop).join(" <span class=\"r-want-m\">·</span> ")]);
    if (b.rent) lines.push(["Напрокат", `${link(b.rent.url, "BookFlow")}<span class="r-want-m">, ${b.rent.free ? "є вільна" : "зараз усі в читачів"}${b.rent.price ? `, ${b.rent.price} ₴` : ""}</span>`]);
    const act = mine
      ? `<button type="button" class="r-pill-line r-want-go" data-open="${esc(mine.path)}">Відкрити</button>`
      : b.free
        ? `<button type="button" class="r-pill-line r-want-go" data-open="${esc(b.free)}" data-act="want-free">Читати безкоштовно</button>`
        : "";
    const none = !act && !lines.length ? `<p class="r-want-none">У магазинах зараз немає. ${link(b.href, "Бібліотеки та інше ↗")}</p>` : "";
    const meta = [b.author, b.year].filter(Boolean).join(" · ");
    return `<div class="r-want-b">
      <button type="button" class="r-want-c" data-act="want-card" data-want="${i}" aria-label="${esc(b.title)}">${window.Shell.rcover({ title: b.title, authors: [b.author] }, b.cover || null)}</button>
      <div class="r-want-w">
        <button type="button" class="r-want-x" data-act="want-card" data-want="${i}"><b>${esc(b.title)}</b>${meta ? `<span class="r-want-a">${esc(meta)}</span>` : ""}</button>
        ${mine ? `<span class="r-want-have">✓ Є у ваших книжках</span>` : ""}
        ${act}
        ${lines.length ? `<div class="r-want-where">${lines.map(([k, v]) => `<div><span class="r-want-k">${esc(k)}</span><span>${v}</span></div>`).join("")}</div>` : ""}
        ${none}
        ${lines.length || act ? `<span class="r-want-all">${link(b.href, "Усе на сторінці книжки ↗")}</span>` : ""}
      </div></div>`;
  }

  function html() {
    const top = `<section class="r-want"><h1 class="r-jh">Хочу прочитати</h1>`;
    if (!books) return `${top}<p class="r-empty">${failed ? "Без мережі список не показати." : `${SPIN}Збираємо…`}</p></section>`;
    if (!books.length) return `${top}<p class="r-want-p">Тут будуть книжки з вашого «Хочу прочитати» на ${link("https://chytai.org.ua/me", "chytai.org.ua ↗")}</p></section>`;
    // What can be read now first: one's own file, then the free shelf; the rest in the shelf's order.
    const rank = (b) => (b.mine ? 0 : b.free ? 1 : 2);
    const list = books.map((b, i) => [b, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]);
    return `${top}<p class="r-want-p">${books.length} ${plural(books.length, "книжка", "книжки", "книжок")} з вашого «Хочу прочитати» на chytai.org.ua</p>${list.map(([b, i]) => row(b, i)).join("")}</section>`;
  }
  function plural(n, one, few, many) {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  }

  document.querySelector("#shell").addEventListener("click", (e) => {
    if (!shown()) return;
    const el = e.target.closest("[data-act='want-card']");
    const b = el && books?.[Number(el.dataset.want)];
    if (b) window.Paper.card({ title: b.title, author: b.author, cover: b.cover || "", href: b.href, year: b.year });
  });

  window.Want = { html, enter: load };
})();
