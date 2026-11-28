// «Полиці» (Max 2026-11-27, variant A of canvas H7RtPE5ytNgCN2uEt22xD7): paper books that stand at home, in an office,
// at a friend's. A page in the panel after «Хочу прочитати» (home.js page «shelves»): one's own shelves and friends'
// ones. A new shelf comes from photos of its spines (Sonnet reads them) or a pasted list (Haiku), each book found in
// the catalog; the reader takes off what is wrong and saves it. «Поділитися» gives a link (/p/<key> → /?shelf=<key>);
// a friend who opens it presses «Стежити», and «Хочу прочитати» shows which wanted books stand on it («Полиці
// друзів», want.js; the card's «У друзів»). They talk outside the app: no messages, no contacts here.
// Server: server/shelves.js and /api/shelves* in server/index.js. Taps count by data-act (reading-time.js): act-shelf-*.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const $ = (s) => document.querySelector(s);
  const SPIN = `<span class="spinner"></span>`;
  const CAM = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
  const SHARE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7"/></svg>`;
  const PEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
  const LOUPE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>`;
  const LIST = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`;
  const plural = (n, a, b, c) => ((t, u) => (t > 10 && t < 20 ? c : u === 1 ? a : u >= 2 && u <= 4 ? b : c))(n % 100, n % 10);
  const nb = (n) => `${n} ${plural(n, "книжка", "книжки", "книжок")}`;
  const low = (s) => (s && !/^.\p{Lu}/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s || "");
  const first = (who) => String(who || "").split(" ")[0];
  const fail = (err) => window.showNotice?.(err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло.", false);
  const cover = (b, url = b.c) => window.Shell.rcover({ title: b.t || "", authors: [b.a || ""] }, url || null);
  const shown = () => $("#shell")?.dataset.page === "shelves";

  let data = null; // { mine: [{ id, name, n, covers, seen }], follows: [{ o, id, name, who, n, covers }] }
  let failed = false;
  let at = "list"; // list | mine:<id> | of:<o>:<id> | link:<key> | review
  let cur = null; // the shelf on screen: { kind, id, o, name, who, books, link, seen, own, on, key } | { error }
  let q = ""; // the search on a shelf
  let rev = null; // a new shelf's books, or books for one: { target, name, books, wait, done, total, errors }

  async function load(fresh = false) {
    try {
      data = await window.reader.shelves();
      failed = false;
    } catch {
      failed = !data;
    }
    const n = $("#r-n-shelves");
    if (n && data) n.textContent = data.mine.length + data.follows.length || "";
    if (shown()) redraw();
    // «Хочу прочитати» names the friends' shelves; drawn again once they are here.
    else if (fresh && $("#shell")?.dataset.page === "want" && document.activeElement?.id !== "r-wq") window.Shell.rerender();
  }
  // Offline (web-bridge.js `viewed`): the server's answer came late, or what was changed here was sent. The shelf on
  // screen takes its books again in place (go() would scroll to the top).
  async function fresh(url) {
    if (!shown()) return;
    if (!url || url === "/api/shelves") load();
    if (url === "/api/shelves") return;
    const [kind, a, b] = at.split(":");
    if (kind !== "mine" && kind !== "of") return;
    const was = at;
    try {
      const r = kind === "mine" ? await window.reader.shelfGet(a) : await window.reader.shelfOf(a, b);
      if (at !== was || !cur || cur.error) return;
      const { id, o } = cur;
      Object.assign(cur, r.shelf || r, { id, o });
      redraw();
    } catch {}
  }
  document.addEventListener("chytai:synced", () => fresh());
  document.addEventListener("chytai:view", (e) => /^\/api\/shelves/.test(e.detail) && fresh(e.detail));
  // Asked by «Хочу прочитати» when it opens, once.
  const ensure = () => !data && !settings.guest && window.reader?.shelves && load(true);
  const redraw = () => {
    const el = document.activeElement?.matches?.(".sh-q") ? document.activeElement : null;
    const caret = el ? [el.selectionStart, el.selectionEnd] : null;
    window.Shell.rerender();
    const n = caret && $(".sh-q");
    if (n) n.focus({ preventScroll: true }), n.setSelectionRange(...caret);
  };
  const label = (s) => `${first(s.who)}, ${low(s.name)}`;

  // ——— the page ———
  const fan = (covers) => `<span class="sh-fan">${(covers || []).slice(0, 3).map((c) => cover({}, c)).join("") || cover({ t: "" })}</span>`;
  const row = (s, open, sub) => `<button type="button" class="sh-row" data-sh-open="${esc(open)}" data-act="shelf-open">${fan(s.covers)}<span class="sh-x"><span class="r-frow-t">${esc(s.title)}</span><span class="r-frow-a">${esc(sub)}</span></span><span class="sh-chev">›</span></button>`;
  const head = (t, n, aside = "") => `<div class="r-sec-head"><h2>${t}${n != null ? ` · ${n}` : ""}</h2>${aside}</div>`;
  const up = `<p class="sh-up"><button type="button" class="r-link" data-sh="list">← Полиці</button></p>`;

  function listHtml() {
    const top = `<section class="r-want sh"><h1 class="r-jh">Полиці</h1>`;
    if (!data) return `${top}<p class="r-empty">${failed ? "Без мережі полиці не показати." : `${SPIN}Збираємо…`}</p></section>`;
    const mine = data.mine.map((s) => row({ ...s, title: s.name }, `mine:${s.id}`, `${nb(s.n)}${s.seen ? ` · додали ${s.seen}` : ""}`)).join("");
    const fr = data.follows.map((s) => row({ ...s, title: label(s) }, `of:${s.o}:${s.id}`, nb(s.n))).join("");
    return `${top}<p class="r-want-p">Паперові книжки вдома, в офісі й у друзів.</p>
      ${head("Мої полиці", data.mine.length || null)}
      ${mine || `<p class="r-want-p">Сфотографуйте полицю або вставте список, і книжки з неї будуть тут.</p>`}
      <p class="sh-new"><button type="button" class="r-pill-line" data-sh="new" data-act="shelf-new">+ Нова полиця</button></p>
      ${head("Полиці друзів", data.follows.length || null)}${fr}
      <p class="r-want-p sh-hint">Друг надсилає посилання на свою полицю. Відкрийте його, і полиця буде тут, а її книжки в «Хочу прочитати».</p></section>`;
  }

  function grid(list) {
    return `<div class="r-want-g">${list.map(([b, i]) => `<div class="r-want-b"><button type="button" class="r-want-c" data-sh-book="${i}" data-act="shelf-book">${cover(b)}<span class="r-want-t">${esc(b.t)}</span></button></div>`).join("")}</div>`;
  }
  function shelfHtml() {
    if (!cur) return `<section class="r-want sh">${up}<p class="r-empty">${SPIN}Відкриваю…</p></section>`;
    if (cur.error) return `<section class="r-want sh">${up}<p class="r-empty">${esc(cur.error)}</p></section>`;
    const mine = cur.kind === "mine" || cur.own;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = cur.books.map((b, i) => [b, i]);
    const list = all.filter(([b]) => words.every((w) => `${b.t} ${b.a}`.toLowerCase().includes(w)));
    // On a friend's shelf the books one wants come first.
    const want = mine ? [] : window.Want?.books?.() || [];
    const wanted = want.length ? all.filter(([b]) => b.h && want.some((w) => w.href === b.h || (w.other || []).some((v) => v.href === b.h))) : [];
    const title = mine ? cur.name : label(cur);
    const seen = cur.seen?.length ? ` · додали ${cur.seen.map((s) => first(s.name)).join(", ")}` : "";
    const sub = mine ? `${nb(cur.books.length)}${seen}` : `Полиця: ${esc(cur.who)} · ${nb(cur.books.length)}`;
    // The top of one's own shelf (Max 2026-11-28, variant A with his changes): a pencil by the name, «+ Додати книжки»
    // as a button and «Поділитися» beside it, then the search: three lines where six were.
    const acts = mine
      ? `<p class="sh-tools"><button type="button" class="r-pill-line sh-add" data-sh="more" data-act="shelf-more">+ Додати книжки</button><button type="button" class="sh-tool" data-sh="share" data-act="shelf-share">${SHARE}Поділитися</button></p>`
      : cur.kind === "link" && !cur.on
        ? `<p class="sh-acts"><button type="button" class="r-pill" data-sh="follow" data-act="shelf-follow">Стежити</button></p><p class="r-want-p">Полиця буде у ваших «Полицях», а її книжки в «Хочу прочитати».</p>`
        : `<p class="sh-acts"><button type="button" class="r-pill-line" data-sh="unfollow" data-act="shelf-unfollow" title="Більше не стежити">✓ Стежу</button></p>`;
    const search = cur.books.length > 12 ? `<label class="r-search sh-search">${LOUPE}<input class="sh-q" type="search" placeholder="Шукати на полиці" autocomplete="off" enterkeyhint="search" value="${esc(q)}" /></label>` : "";
    const pen = mine ? pencil() : "";
    const empty = !cur.books.length ? `<p class="r-want-p">Поки порожньо.</p>` : "";
    return `<section class="r-want sh">${up}<div class="sh-top"><h1 class="r-jh sh-h">${esc(title)}</h1>${pen}</div>
      <p class="r-want-p sh-sub">${sub}</p>${cur.about ? `<p class="sh-about">${esc(cur.about)}</p>` : ""}${acts}${search}${empty}
      ${wanted.length && !q ? head("Є у вашому «Хочу прочитати»", wanted.length) + grid(wanted) : ""}
      ${cur.books.length ? head(q ? "Знайшлося" : "Усі", list.length) + grid(list) : ""}</section>`;
  }

  // After photos or a pasted list: what was found, ticks to take off; the ones the catalog lacks apart.
  function reviewHtml() {
    const r = rev;
    const rowR = (b, i) => `<label class="sh-rrow${b.miss ? " sh-miss" : ""}">${b.miss ? `<span class="sh-blank"></span>` : cover(b)}<span class="r-frow-x"><span class="r-frow-t">${esc(b.t)}</span><span class="r-frow-a">${esc(b.a || "Без автора")}</span></span><input type="checkbox" data-sh-tick="${i}"${b.off ? "" : " checked"} /></label>`;
    const found = r.books.map((b, i) => [b, i]).filter(([b]) => !b.miss);
    const miss = r.books.map((b, i) => [b, i]).filter(([b]) => b.miss);
    const on = r.books.filter((b) => !b.off).length;
    const wait = r.wait ? `<p class="sh-wait">${SPIN}${esc(r.wait)}</p>` : "";
    const errs = r.errors.length ? `<p class="r-want-p sh-err">${esc(r.errors[r.errors.length - 1])}</p>` : "";
    const none = !r.wait && !r.books.length ? `<p class="r-want-p">Книжок не знайшли. Спробуйте фото ближче, щоб корінці було видно, або вставте список.</p>` : "";
    const lead = r.books.length ? `<p class="r-want-p">${r.total > 1 ? `З ${r.total} фото знайшли` : "Знайшли"} ${nb(r.books.length)}. Зніміть позначку із зайвих.</p>` : "";
    return `<section class="r-want sh">${up}<h1 class="r-jh sh-h">${esc(r.name)}</h1>${lead}${wait}${errs}${none}
      ${found.length ? head("Знайшли", found.length) + `<div class="sh-rev">${found.map(([b, i]) => rowR(b, i)).join("")}</div>` : ""}
      ${miss.length ? head("Немає в каталозі", miss.length) + `<div class="sh-rev">${miss.map(([b, i]) => rowR(b, i)).join("")}</div>` : ""}
      <p class="sh-acts"><button type="button" class="r-pill-line" data-sh="photo" data-act="shelf-photo">+ Ще фото</button><button type="button" class="r-pill-line" data-sh="paste" data-act="shelf-paste">Вставити список</button></p>
      <div class="sh-save"><button type="button" class="r-pill" data-sh="save" data-act="shelf-save"${on && !r.wait ? "" : " disabled"}>${r.target ? "Додати на полицю" : "Зберегти полицю"}</button><span>${on ? nb(on) : ""}</span></div></section>`;
  }

  // The phone's header names what is on screen: the shelf, else «Полиці».
  function title() {
    if (at === "review" && rev) return rev.name;
    if (at === "list" || !cur || cur.error) return "Полиці";
    return cur.kind === "mine" || cur.own ? cur.name : label(cur);
  }
  // The pencil by one's own shelf's name (in the phone's header too): «Назва полиці».
  const pencil = () => `<button type="button" class="sh-pen" data-sh="rename" data-act="shelf-rename" aria-label="Змінити назву" title="Змінити назву">${PEN}</button>`;
  function html() {
    $("#shell").classList.toggle("sh-deep", at !== "list"); // a shelf: «‹» in the phone's header (variant А)
    const h = $(".r-head-p h1");
    if (h) h.textContent = title();
    const hx = $(".r-head-p .sh-hpen");
    if (hx) hx.innerHTML = at !== "list" && at !== "review" && cur && !cur.error && (cur.kind === "mine" || cur.own) ? pencil() : "";
    if (at === "review" && rev) return reviewHtml();
    if (at !== "list") return shelfHtml();
    return listHtml();
  }

  // ——— moving between them ———
  async function go(next) {
    at = next;
    q = "";
    cur = null;
    if (!shown()) (going = true), window.Shell.setPage("shelves"), (going = false);
    $("#home").scrollTop = 0;
    redraw();
    if (next === "list") return load();
    if (next === "review") return;
    const [kind, a, b] = next.split(":");
    try {
      const r = kind === "mine" ? await window.reader.shelfGet(a) : kind === "of" ? await window.reader.shelfOf(a, b) : await window.reader.shelfByKey(a);
      if (at !== next) return;
      const s = r.shelf || r;
      cur = { kind, key: kind === "link" ? a : "", ...s, id: s.id ?? a, o: s.o ?? (kind === "of" ? a : "") };
      if (kind === "of") cur.id = b;
      // One's own link, or one already added: the shelf as it is.
      if (kind === "link" && r.own) return go(`mine:${r.id}`);
      if (kind === "link" && r.on) return go(`of:${r.o}:${r.id}`);
      // A friend's shelf puts one's wanted books first: the list, if «Хочу прочитати» hasn't been asked yet.
      if (!window.Want?.books?.().length) window.Want?.refresh?.().then(() => at === next && shown() && redraw());
    } catch (err) {
      if (at !== next) return;
      cur = { error: err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло." };
    }
    if (shown()) redraw();
  }
  // Android's back and Esc: from a shelf to the list first.
  function back() {
    if (!shown() || at === "list") return false;
    if (at === "review" && rev?.target) return go(`mine:${rev.target}`), true;
    go("list");
    return true;
  }
  // The panel's «Полиці»: the list (a review in progress stays).
  let going = false;
  function enter() {
    if (going) return;
    if (!(at === "review" && rev)) (at = "list"), (cur = null), (q = "");
    load();
  }

  // ——— sheets (#shelf-dialog, like «Мої бібліотеки») ———
  const dlg = () => $("#shelf-dialog");
  let onDone = null; // what «Готово» / the main button does
  function sheet(h, sub, body, done = "Готово", then = null) {
    const d = dlg();
    d.querySelector("h2").textContent = h;
    d.querySelector("#sd-sub").textContent = sub;
    d.querySelector("#sd-sub").hidden = !sub;
    d.querySelector("#sd-body").innerHTML = body;
    d.querySelector(".ab-foot .r-pill").textContent = done;
    onDone = then;
    if (!d.open) d.showModal();
    document.activeElement?.blur?.();
  }
  function newSheet(target = null) {
    const s = target ? cur : null;
    sheet(target ? "Додати книжки" : "Нова полиця", target ? `На полицю «${s.name}».` : "Книжки, які стоять у вас удома чи в офісі.", `
      ${target ? "" : `<input class="lb-q sh-name" type="text" maxlength="40" placeholder="Назва: Дім, Офіс…" autocomplete="off" />`}
      <div class="sh-ways">
        <button type="button" class="sh-way" data-sh="photo" data-act="shelf-photo">${CAM}<span><b>Сфотографувати полицю</b><small>Щоб корінці було видно. Можна кілька фото</small></span></button>
        <button type="button" class="sh-way" data-sh="paste" data-act="shelf-paste">${LIST}<span><b>Вставити список</b><small>Назва й автор, кожна з нового рядка</small></span></button>
      </div>`, "Скасувати");
    dlg().dataset.target = target || "";
  }
  // The name the reader typed in the sheet, or the shelf's own.
  const sheetName = () => (dlg().querySelector(".sh-name")?.value || "").trim().slice(0, 40);
  function startReview(name, target) {
    if (at === "review" && rev) return; // more photos for the same review
    rev = { target, name: name || (target ? cur?.name : "") || "Полиця", books: [], wait: "", done: 0, total: 0, errors: [] };
    go("review");
  }
  const keyOf = (b) => b.h || `${String(b.t).toLowerCase()}|${String(b.a).toLowerCase()}`;
  function addFound(list) {
    const have = new Set(rev.books.map(keyOf));
    for (const b of list || []) if (!have.has(keyOf(b))) have.add(keyOf(b)), rev.books.push(b);
  }
  function pickPhotos() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => resolve([...(input.files || [])].slice(0, 20));
      input.click();
    });
  }
  async function photos() {
    const name = sheetName();
    const target = dlg().dataset.target || rev?.target || null;
    const files = await pickPhotos();
    if (!files.length) return;
    if (dlg().open) dlg().close();
    startReview(name, target);
    rev.total += files.length;
    for (const f of files) {
      rev.wait = `Читаю корінці: ${rev.done + 1} з ${rev.total} фото${rev.books.length ? `, ${nb(rev.books.length)}` : ""}`;
      if (shown() && at === "review") redraw();
      try {
        const blob = await window.Paper.shrink(f, 1600);
        const r = await window.reader.shelfRead(blob);
        addFound(r.books);
      } catch (err) {
        rev.errors.push(err instanceof TypeError ? "Немає з'єднання." : err.message || "Фото не прочиталося.");
      }
      rev.done++;
    }
    rev.wait = "";
    if (shown() && at === "review") redraw();
  }
  function pasteSheet() {
    const name = sheetName();
    const target = dlg().dataset.target || rev?.target || "";
    sheet("Вставити список", "Назва й автор, кожна з нового рядка. Підійде й список з ChatGPT.", `<textarea class="sh-paste" rows="10" placeholder="Кобзар — Тарас Шевченко"></textarea>`, "Знайти книжки", async () => {
      const text = dlg().querySelector(".sh-paste").value.trim();
      if (text.length < 3) return;
      dlg().close();
      startReview(name, target || null);
      rev.wait = "Шукаю книжки…";
      redraw();
      try {
        const r = await window.reader.shelfRead(text);
        addFound(r.books);
      } catch (err) {
        rev.errors.push(err instanceof TypeError ? "Немає з'єднання." : err.message || "Список не прочитався.");
      }
      rev.wait = "";
      if (shown() && at === "review") redraw();
    });
    dlg().dataset.target = target;
    setTimeout(() => dlg().querySelector(".sh-paste")?.focus(), 50);
  }
  async function save(btn) {
    const add = rev.books.filter((b) => !b.off).map(({ t, a, h, c }) => ({ t, a, h, c }));
    if (!add.length) return;
    btn.disabled = true;
    try {
      const id = rev.target || (await window.reader.shelfNew(rev.name)).shelf.id;
      rev.target = id; // a second press doesn't make a second shelf
      await window.reader.shelfChange(id, { add });
      rev = null;
      go(`mine:${id}`);
      load();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }

  async function shareSheet(fresh = false) {
    const s = cur;
    sheet("Поділитися полицею", "Хто має посилання, бачить книжки цієї полиці й може стежити за нею.", `<p class="lb-note">${SPIN}</p>`);
    let link = "";
    try {
      link = (await window.reader.shelfShare(s.id, fresh)).link;
    } catch (err) {
      return (dlg().querySelector("#sd-body").innerHTML = `<p class="lb-note">${esc(err instanceof TypeError ? "Немає з'єднання." : err.message)}</p>`);
    }
    s.link = link;
    const who = s.seen?.length
      ? `<p class="lb-note sh-sh">Стежать:</p><ul class="lb-list sh-who">${s.seen.map((p) => `<li><label>${esc(p.name)}${p.username ? ` <small>@${esc(p.username)}</small>` : ""}<button type="button" class="r-link" data-sh-kick="${esc(p.id)}" data-act="shelf-kick">Прибрати</button></label></li>`).join("")}</ul>`
      : `<p class="lb-note sh-sh">Поки ніхто не додав.</p>`;
    dlg().querySelector("#sd-body").innerHTML = `<div class="sh-link"><input class="lb-q" readonly value="${esc(link)}" /><button type="button" class="r-pill" data-sh="copy" data-act="shelf-copy">Копіювати</button></div>
      ${who}<p class="lb-note"><button type="button" class="r-link" data-sh="fresh" data-act="shelf-fresh">Нове посилання</button> · старе перестане працювати</p>`;
  }
  async function copy(btn) {
    const input = dlg().querySelector(".sh-link input");
    try {
      await navigator.clipboard.writeText(input.value);
      btn.textContent = "Скопійовано";
    } catch {
      input.select();
    }
  }
  async function kick(btn) {
    btn.disabled = true;
    try {
      await window.reader.shelfKick(cur.id, btn.dataset.shKick);
      cur.seen = cur.seen.filter((p) => p.id !== btn.dataset.shKick);
      btn.closest("li").remove();
      redraw();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }
  // The pencil: the name and the owner's own words (Max 2026-11-28: whether they lend books, anything), shown under
  // the name to everyone who opens the shelf.
  function renameSheet() {
    sheet("Полиця", "", `<input class="lb-q sh-name" type="text" maxlength="40" value="${esc(cur.name)}" autocomplete="off" />
      <textarea class="sh-about-in" rows="4" maxlength="1000" placeholder="Про полицю: що тут стоїть, чи даєте книжки почитати…">${esc(cur.about || "")}</textarea>
      <p class="lb-note sh-del"><button type="button" class="r-link" data-sh="delete" data-act="shelf-delete">Видалити полицю</button></p>`, "Зберегти", async () => {
      const name = sheetName();
      const about = (dlg().querySelector(".sh-about-in")?.value || "").trim().slice(0, 1000);
      dlg().close();
      const change = {};
      if (name && name !== cur.name) change.name = name;
      if (about !== (cur.about || "")) change.about = about;
      if (!Object.keys(change).length) return;
      try {
        await window.reader.shelfChange(cur.id, change);
        Object.assign(cur, change);
        redraw();
        load();
      } catch (err) {
        fail(err);
      }
    });
  }
  async function del(btn) {
    // Asked once more in place: the button says what happens.
    if (!btn.dataset.sure) return (btn.dataset.sure = "1"), (btn.textContent = `Так, видалити «${cur.name}»${cur.seen?.length ? ` і в ${cur.seen.length} друзів` : ""}`);
    try {
      await window.reader.shelfDelete(cur.id);
      dlg().close();
      go("list");
    } catch (err) {
      fail(err);
    }
  }
  async function follow(btn) {
    btn.disabled = true;
    try {
      const r = await window.reader.shelfFollow(cur.key);
      go(`of:${r.o}:${r.id}`);
      load();
      window.Want?.refresh?.();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }
  async function unfollow(btn) {
    btn.disabled = true;
    try {
      await window.reader.shelfUnfollow(cur.o, cur.id);
      go("list");
      window.Want?.refresh?.();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }

  // A book's card: on one's own shelf «Прибрати з полиці»; on a friend's whose shelf it is, to ask them for it. Both
  // have «Хочу прочитати» (Max 2026-11-28: unread books at his office too), the slot mentions.js fills as on a
  // mentioned book's card («✓ У «Хочу прочитати»» once there; a book the catalog lacks is looked for first).
  function bookCard(i) {
    const b = cur?.books?.[i];
    if (!b) return;
    const mine = cur.kind === "mine";
    const top = mine ? "" : `<div class="r-want-where"><div><span class="r-want-k">Полиця</span><span>${esc(label(cur))}<span class="r-want-m"><br>Напишіть, щоб позичити</span></span></div></div>`;
    const page = b.h ? `<p class="pf-page"><a href="${esc(b.h)}" target="_blank" rel="noopener" data-act="shelf-page">Сторінка книжки на Chytai ↗</a></p>` : "";
    const drop = mine ? `<p class="mn-dropp"><button type="button" class="r-link mn-drop" data-sh-drop="${i}" data-act="shelf-drop">Прибрати з полиці</button></p>` : "";
    const book = { title: b.t, author: b.a, cover: b.c || "", href: b.h || "" };
    window.Paper.card(book, { top, noAdd: true, foot: `<div id="mn-want"></div>${page}${drop}` });
    window.Mentions?.want(book);
  }
  async function drop(btn) {
    const i = Number(btn.dataset.shDrop);
    btn.disabled = true;
    try {
      const b = cur.books[i];
      await window.reader.shelfChange(cur.id, { drop: [i], dropBooks: [{ t: b.t, a: b.a, h: b.h || "" }] });
      cur.books.splice(i, 1);
      $("#paper-found").close();
      redraw();
      load();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }

  // ——— in «Хочу прочитати» (want.js) ———
  const follows = () => data?.follows || [];
  // Under a cover: whose shelf, «Макс, офіс» or «Макс +1».
  const cap = (b) => ((l) => (l.length ? `${first(l[0].who)}${l.length > 1 ? ` +${l.length - 1}` : `, ${low(l[0].name)}`}` : ""))(b.shelves || []);
  // The card's first row in «Де взяти»: each shelf, a tap opens it.
  const cardRow = (b) =>
    b.shelves?.length
      ? `<div><span class="r-want-k">У друзів</span><span>${b.shelves.map((s) => `<button type="button" class="r-link sh-to" data-sh-open="of:${esc(s.o)}:${esc(s.id)}" data-act="want-shelf-open">${esc(label(s))}</button>`).join("<br>")}<span class="r-want-m sh-ask"><br>Напишіть, щоб позичити</span></span></div>`
      : "";

  // ——— taps ———
  function click(e) {
    const o = e.target.closest("[data-sh-open]");
    if (o) {
      if ($("#paper-found").open) $("#paper-found").close();
      if (dlg().open) dlg().close();
      return go(o.dataset.shOpen);
    }
    const t = e.target.closest("[data-sh-book]");
    if (t && shown()) return bookCard(Number(t.dataset.shBook));
    const a = e.target.closest("[data-sh]");
    if (!a) return;
    const k = a.dataset.sh;
    if (k === "list") return dlg().open && dlg().close(), go("list");
    if (k === "new") return newSheet();
    if (k === "more") return newSheet(cur.id);
    if (k === "photo") return photos();
    if (k === "paste") return pasteSheet();
    if (k === "save") return save(a);
    if (k === "share") return shareSheet();
    if (k === "fresh") return shareSheet(true);
    if (k === "copy") return copy(a);
    if (k === "rename") return renameSheet();
    if (k === "delete") return del(a);
    if (k === "follow") return follow(a);
    if (k === "unfollow") return unfollow(a);
  }
  document.addEventListener("click", click);
  // The phone header's ‹ on a shelf goes to the list of shelves, not home.
  $(".r-head-p .r-back")?.addEventListener("click", (e) => back() && (e.stopPropagation(), e.preventDefault()), true);
  $("#paper-found").addEventListener("click", (e) => {
    const d = e.target.closest("[data-sh-drop]");
    if (d) drop(d);
  });
  const d = dlg();
  d.addEventListener("click", (e) => {
    const k = e.target.closest("[data-sh-kick]");
    if (k) return kick(k);
    // «Готово» / the sheet's main button: its own step, if it has one.
    const main = e.target.closest(".ab-foot .r-pill");
    if (main && onDone) e.preventDefault(), onDone();
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
  });
  d.addEventListener("close", () => (onDone = null));
  $("#shell").addEventListener("change", (e) => {
    const box = e.target.closest("[data-sh-tick]");
    if (!box || !rev) return;
    rev.books[Number(box.dataset.shTick)].off = !box.checked;
    const on = rev.books.filter((b) => !b.off).length;
    const s = $(".sh-save");
    if (s) (s.querySelector("span").textContent = on ? nb(on) : ""), (s.querySelector("button").disabled = !on || !!rev.wait);
  });
  $("#shell").addEventListener("input", (e) => {
    if (!e.target.matches(".sh-q")) return;
    q = e.target.value;
    redraw();
  });

  // A shelf's link (/p/<key> → /?shelf=<key>): its page, with «Стежити».
  const key = new URLSearchParams(location.search).get("shelf");
  if (key) {
    history.replaceState(history.state, "", "/");
    // After home.js has shown the home screen (its own settingsReady step runs first).
    settingsReady.then(() => !settings.guest && go(`link:${key.replace(/[^A-Za-z0-9]/g, "")}`)).catch(() => {});
  }
  // The panel's count, a few seconds after the page loads.
  setTimeout(() => !document.body.classList.contains("guest") && !data && window.reader?.shelves && load(), 5000);

  window.Shelves = { html, enter, back, go, cap, cardRow, follows, ensure, label };
})();
