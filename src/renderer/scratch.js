// «Scratchpad» (Max 2026-11-23, variant A of canvas 5vFceFdJnh3oNewFR6TgT4; the name until a Ukrainian one is
// found): an inbox for reading. A topic, an era, an author or a book jotted in a few words, by voice or as a photo;
// the server (server/scratch.js) has Opus explain it and name books to start with, and the reader later sorts it
// out: «Готово» or «Не цікаво». A page in the panel under «Статистика» (home.js page «scratch»), one entry open at a
// time in place of the list. Taps count by data-act (reading-time.js): act-scr-*.
/* global showNotice */
(() => {
  const $ = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const norm = (s) => String(s || "").toLowerCase().replace(/[«»"'’ʼ.,:;!?()—–-]/g, " ").replace(/\s+/g, " ").trim();
  const plural = (n, one, few, many) => {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  };
  const KIND = { topic: "Тема", era: "Епоха", author: "Автор", book: "Книжка", unclear: "" };
  const LANG = { en: "англійською", uk: "українською", fr: "французькою", de: "німецькою", pl: "польською", es: "іспанською", it: "італійською" };
  const MIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  const CAM = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
  const SPIN = `<span class="spinner"></span>`;

  let items = null; // null until the server answers, "…" never: the last list stays while asked again
  let open = null; // the entry shown, by id
  let sorted = false; // «Розібрані» unfolded
  let draft = "";
  let voice = false; // the draft was dictated
  let photo = null; // { blob, url } waiting in the form
  let sending = false;
  let ask = ""; // «Уточнити» typed
  let poll = null;
  let failed = false;

  const shown = () => document.querySelector("#shell")?.dataset.page === "scratch";
  const typing = () => ["scr-text", "scr-ask"].includes(document.activeElement?.id);
  // Not while a field has the finger: the page drawn anew would take the field away (the next poll draws it).
  const rerender = () => shown() && !typing() && window.Shell.rerender();
  const byId = (id) => (items || []).find((x) => x.id === id);
  const fresh = () => (items || []).filter((x) => x.state === "new");

  function count() {
    const n = fresh().length;
    const el = $("#r-n-scratch");
    if (el) el.textContent = n || "";
  }

  async function load() {
    try {
      items = (await window.reader.scratchList()).items;
      failed = false;
    } catch {
      failed = !items;
    }
    count();
    rerender();
    watch();
  }
  // Asked again every 3 s while an answer is being made and the page is on screen.
  function watch() {
    clearTimeout(poll);
    if ((items || []).some((x) => x.status === "wait") && shown() && document.visibilityState === "visible") poll = setTimeout(load, 3000);
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && shown() && load());

  const title = (it) => (it.status === "ok" && it.ai?.title && it.ai.kind !== "unclear" ? it.ai.title : it.text || "Фото");
  // The catalog's title without its subtitle («Психологія грошей. Нетлінні уроки…»).
  const bookTitle = (b) => (b.href && b.ctitle ? b.ctitle.split(/[.:] /)[0] : "") || b.title_uk || b.title;
  const bookAuthor = (b) => (b.href && b.cauthor) || b.author_uk || b.author;
  const cover = (b) => window.Shell.rcover({ title: bookTitle(b), authors: [bookAuthor(b)] }, b.cover || null);
  const mine = (b) => {
    const t = norm(bookTitle(b));
    return (window.Shell.books?.() || []).some((x) => (b.href && x.href === b.href) || norm(x.title) === t);
  };

  function sub(it) {
    if (it.status === "wait") return `${SPIN}Розбираємо…`;
    if (it.status === "limit") return "Розберемо завтра";
    if (it.status === "fail") return "Не вдалося розібрати";
    const a = it.ai || {};
    if (a.kind === "unclear") return "Не зрозуміли, що це. Уточніть?";
    const n = a.books?.length || 0;
    return [KIND[a.kind], n ? `${n} ${plural(n, "книжка", "книжки", "книжок")}` : "", it.text && norm(it.text) !== norm(a.title) ? `«${esc(it.text.length > 60 ? `${it.text.slice(0, 58)}…` : it.text)}»` : ""].filter(Boolean).join(" · ");
  }
  function fan(it) {
    const books = it.status === "ok" ? it.ai?.books || [] : [];
    if (books.length) return `<span class="r-scr-fan n${Math.min(3, books.length)}" aria-hidden="true">${books.slice(0, 3).map(cover).join("")}</span>`;
    if (it.photo) return `<span class="r-scr-fan"><img class="r-scr-thumb" src="/api/scratch/${it.id}/photo" alt="" loading="lazy"></span>`;
    return "";
  }
  const row = (it) => `<button type="button" class="r-scr-item${it.state !== "new" ? " sorted" : ""}" data-scr-open="${it.id}">
      <span class="r-scr-x"><b class="${it.status === "ok" && it.ai?.kind !== "unclear" ? "" : "raw"}">${esc(title(it))}</b><span class="r-scr-m">${sub(it)}</span></span>${fan(it)}</button>`;

  function formHtml() {
    return `<form class="r-scr-form" id="scr-form">
      <label for="scr-text" class="r-scr-hint">Тема, епоха, автор чи книжка. Розберемо самі.</label>
      ${photo ? `<span class="r-scr-shot"><img src="${photo.url}" alt="Фото до запису"><button type="button" data-act="scr-unphoto" aria-label="Прибрати фото">×</button></span>` : ""}
      <textarea id="scr-text" rows="2" placeholder="Що хочете почитати потім?" enterkeyhint="done">${esc(draft)}</textarea>
      <div class="r-scr-row">
        <button type="button" class="pp-tool${window.Dictation?.field() === "scr-text" ? " on" : ""}" data-act="scr-mic" title="Надиктувати" aria-label="Надиктувати">${MIC}</button>
        <button type="button" class="pp-tool" data-act="scr-photo" title="Фото" aria-label="Додати фото">${CAM}</button>
        <span class="r-scr-sp"></span>
        <button type="submit" class="r-pill"${sending ? " disabled" : ""}>${sending ? "Записую…" : "Записати"}</button>
      </div></form>`;
  }

  function listHtml() {
    let html = `<section class="r-scr"><h1 class="r-jh">Scratchpad</h1>${formHtml()}`;
    if (!items) return `${html}<p class="r-empty">${failed ? "Без мережі записів не показати." : `${SPIN}Завантажуємо…`}</p></section>`;
    const now = fresh();
    const done = items.filter((x) => x.state !== "new");
    html += now.length ? `<div class="r-sec-head"><h2>Нові · ${now.length}</h2></div>${now.map(row).join("")}` : `<p class="r-empty r-scr-none">${done.length ? "Усе розібрано." : "Тут з'являться теми, автори й книжки, які ви запишете на потім."}</p>`;
    if (done.length) {
      html += `<button type="button" class="r-scr-more" data-act="scr-sorted">Розібрані · ${done.length}<span aria-hidden="true">${sorted ? "⌃" : "›"}</span></button>`;
      if (sorted) html += done.slice(0, 200).map(row).join("");
    }
    return `${html}</section>`;
  }

  function bookHtml(b, i) {
    const lang = b.title_uk ? "є українською" : LANG[b.lang] || "";
    const meta = [bookAuthor(b), lang, b.nonfiction ? "нонфікшн" : ""].filter(Boolean).join(" · ");
    const have = mine(b);
    return `<div class="r-scr-book">
      <button type="button" class="r-scr-bc" data-act="scr-book" data-scr-book="${i}" aria-label="${esc(bookTitle(b))}">${cover(b)}</button>
      <button type="button" class="r-scr-bx" data-act="scr-book" data-scr-book="${i}"><b>${esc(bookTitle(b))}</b><span class="r-scr-bm">${esc(meta)}</span>${b.why ? `<span class="r-scr-why">${esc(b.why)}</span>` : ""}</button>
      ${have ? `<span class="r-scr-have">✓ У моїх</span>` : `<button type="button" class="r-pill-line r-scr-add" data-act="scr-add" data-scr-book="${i}">Додати</button>`}</div>`;
  }

  function oneHtml(it) {
    const at = new Date(it.at);
    const day = window.Shell.when?.(it.at) || "";
    const time = at.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    const said = [it.text ? `«${esc(it.text)}»` : "", `${esc(day)}${day ? ", " : ""}${time}`, it.voice ? "голосом" : ""].filter(Boolean).join(" · ");
    let html = `<section class="r-scr r-scr-one"><button type="button" class="r-scr-back" data-act="scr-back">‹ Scratchpad</button>
      <p class="r-scr-said">${said}</p>
      ${it.photo ? `<img class="r-scr-photo" src="/api/scratch/${it.id}/photo" alt="Фото до запису">` : ""}`;
    const a = it.ai;
    if (it.status === "wait") html += `<p class="r-scr-state">${SPIN}Розбираємо: шукаємо, що це і що почитати…</p>`;
    else if (it.status === "limit") html += `<p class="r-scr-state">На сьогодні розборів досить. Розберемо завтра.</p>`;
    else if (it.status === "fail") html += `<p class="r-scr-state">Не вдалося розібрати. <button type="button" class="r-link" data-act="scr-again">Ще раз</button></p>`;
    else if (a?.kind === "unclear") {
      html += `<p class="r-scr-state">Не зрозуміли, що це.${a.guesses?.length ? " Може, це:" : " Уточніть нижче."}</p>
        ${a.guesses?.length ? `<div class="r-scr-guess">${a.guesses.map((g, i) => `<button type="button" data-act="scr-guess" data-scr-guess="${i}">${esc(g)}</button>`).join("")}</div>` : ""}`;
    } else if (a) {
      html += `<span class="r-scr-kind">${KIND[a.kind] || ""}</span><h1 class="r-scr-t">${esc(a.title)}</h1>
        ${a.about ? `<p class="r-scr-about">${esc(a.about)}</p>` : ""}
        ${a.books?.length ? `<div class="r-sec-head"><h2>З чого почати</h2></div>${a.books.map(bookHtml).join("")}` : ""}`;
    }
    if (it.status !== "wait") {
      const asked = (it.ask || []).length ? `<p class="r-scr-asked">Уточнено: ${(it.ask || []).map((x) => `«${esc(x)}»`).join(", ")}</p>` : "";
      html += `<form class="r-scr-ask" id="scr-ask-form">${asked}<label for="scr-ask">Уточнити</label>
        <span class="r-scr-askrow"><input id="scr-ask" type="text" autocomplete="off" placeholder="щось українською, тільки нонфікшн…" value="${esc(ask)}"><button type="submit" class="r-pill" aria-label="Уточнити">→</button></span></form>`;
    }
    html += it.state === "new"
      ? `<div class="r-scr-foot"><button type="button" class="r-link r-scr-skip" data-act="scr-skip">Не цікаво</button><button type="button" class="r-pill" data-act="scr-done">Готово</button></div>`
      : `<div class="r-scr-foot"><span class="r-scr-was">${it.state === "done" ? "Розібрано" : "Не цікаво"}</span><button type="button" class="r-link" data-act="scr-delete">Видалити</button><button type="button" class="r-pill-line" data-act="scr-renew">Повернути в нові</button></div>`;
    return `${html}</section>`;
  }

  function html() {
    const it = open && byId(open);
    if (open && !it && items) open = null;
    watch();
    return it ? oneHtml(it) : listHtml();
  }

  // The page opens: the list again from the server.
  function enter() {
    open = null;
    load();
  }
  // Android's back and the header's: an entry goes back to the list.
  function back() {
    if (!open) return false;
    open = null;
    ask = "";
    rerender();
    $("#home").scrollTop = 0;
    return true;
  }

  function put(it) {
    if (!it) return;
    const i = (items || []).findIndex((x) => x.id === it.id);
    if (i < 0) items = [it, ...(items || [])];
    else items[i] = it;
    count();
  }
  const oops = (err, what) => showNotice(err instanceof TypeError ? `Немає з'єднання: ${what} можна лише онлайн.` : err.message || "Не вийшло.", false);

  async function send() {
    const text = ($("#scr-text")?.value ?? draft).trim();
    if ((!text && !photo) || sending) return;
    window.Dictation?.stop();
    document.activeElement?.blur();
    sending = true;
    rerender();
    try {
      let b64 = "";
      if (photo) {
        const buf = new Uint8Array(await photo.blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        b64 = btoa(s);
      }
      const { item } = await window.reader.scratchAdd({ text, photo: b64, voice });
      put(item);
      window.ReadingTime?.count("scr-write");
      draft = "";
      voice = false;
      if (photo) URL.revokeObjectURL(photo.url);
      photo = null;
    } catch (err) {
      oops(err, "записати");
    }
    sending = false;
    rerender();
  }

  async function addPhoto() {
    const file = await window.Paper.pickPhoto();
    if (!file) return;
    const blob = await window.Paper.shrink(file, 1200);
    if (photo) URL.revokeObjectURL(photo.url);
    photo = { blob, url: URL.createObjectURL(blob) };
    // Drawn now even when the field has the finger (typed while the photo was shrunk): the caret is put back.
    const f = $("#scr-text");
    draft = f?.value ?? draft;
    const at = document.activeElement === f ? f.selectionStart : null;
    if (shown()) window.Shell.rerender();
    if (at != null) $("#scr-text")?.focus(), $("#scr-text")?.setSelectionRange(at, at);
  }

  async function act(name, el) {
    const it = open && byId(open);
    if (name === "scr-mic") return (voice = true), window.Dictation.toggle("scr-text", '[data-act="scr-mic"]');
    if (name === "scr-photo") return addPhoto();
    if (name === "scr-unphoto") return photo && URL.revokeObjectURL(photo.url), (photo = null), (draft = $("#scr-text")?.value ?? draft), rerender();
    if (name === "scr-sorted") return (sorted = !sorted), rerender();
    if (name === "scr-back") return back();
    if (!it) return;
    const i = Number(el.dataset.scrBook);
    const b = it.ai?.books?.[i];
    if (name === "scr-book" && b) return window.Paper.card({ title: bookTitle(b), author: bookAuthor(b), cover: b.cover || "", href: b.href || "", year: b.year });
    if (name === "scr-add" && b) {
      el.disabled = true;
      try {
        await window.reader.paperAdd(b.href ? { title: bookTitle(b), author: bookAuthor(b), cover: b.cover, href: b.href } : { title: bookTitle(b), author: bookAuthor(b) });
        await window.Shell.reload();
        showNotice(`«${bookTitle(b)}» у ваших книжках.`, false);
      } catch (err) {
        oops(err, "додати книжку");
      }
      return rerender();
    }
    try {
      if (name === "scr-guess") return put((await window.reader.scratchAsk(it.id, { text: `Мається на увазі: ${it.ai?.guesses?.[Number(el.dataset.scrGuess)] || ""}` })).item), rerender(), watch();
      if (name === "scr-again") return put((await window.reader.scratchAsk(it.id, { again: true })).item), rerender(), watch();
      if (name === "scr-done" || name === "scr-skip" || name === "scr-renew") {
        put((await window.reader.scratchState(it.id, name === "scr-done" ? "done" : name === "scr-skip" ? "skip" : "new")).item);
        if (name !== "scr-renew") back();
        else rerender();
        return;
      }
      if (name === "scr-delete") {
        await window.reader.scratchDelete(it.id);
        items = items.filter((x) => x.id !== it.id);
        count();
        return back();
      }
    } catch (err) {
      oops(err, "це зробити");
    }
  }

  const shell = $("#shell");
  // Before home.js: the header's «назад» on an entry goes back to the list, not home.
  shell.addEventListener("click", (e) => {
    if (shown() && open && e.target.closest(".r-head-s .r-back")) e.stopPropagation(), back();
  }, true);
  shell.addEventListener("click", (e) => {
    if (!shown()) return;
    const o = e.target.closest("[data-scr-open]");
    if (o) {
      open = o.dataset.scrOpen;
      ask = "";
      rerender();
      $("#home").scrollTop = 0;
      return;
    }
    const el = e.target.closest("[data-act^='scr-']");
    if (el) act(el.dataset.act, el);
  });
  shell.addEventListener("input", (e) => {
    if (e.target.id === "scr-text") draft = e.target.value;
    if (e.target.id === "scr-ask") ask = e.target.value;
  });
  shell.addEventListener("submit", async (e) => {
    if (e.target.id === "scr-form") return e.preventDefault(), send();
    if (e.target.id !== "scr-ask-form") return;
    e.preventDefault();
    const it = open && byId(open);
    const text = ask.trim();
    if (!it || !text) return;
    document.activeElement?.blur();
    try {
      put((await window.reader.scratchAsk(it.id, { text })).item);
      ask = "";
    } catch (err) {
      oops(err, "уточнити");
    }
    rerender();
    watch();
  });
  // Enter in the field writes the entry on a computer; a phone's Enter is a new line.
  shell.addEventListener("keydown", (e) => {
    if (e.target.id === "scr-text" && e.key === "Enter" && !e.shiftKey && matchMedia("(hover: hover)").matches) e.preventDefault(), send();
  });

  window.Scratch = { html, enter, back, load, typing };
})();
