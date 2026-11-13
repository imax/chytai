// Client side of the web platform: filtering and sorting of the shelves and catalogs, dialogs, the
// menu on phones, the switches of the homepage, /community and /publishers.
// Everything else is plain forms handled by the server.
(function () {
  // How long this page took to open here (/admin/speed): once it has loaded, two numbers and whether this is a phone.
  addEventListener("load", () => setTimeout(() => {
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      if (!nav || nav.type === "back_forward" || document.visibilityState !== "visible") return;
      const phone = matchMedia("(pointer: coarse)").matches && innerWidth < 900;
      navigator.sendBeacon?.("/api/speed", new Blob([JSON.stringify({ load: nav.loadEventEnd || nav.domContentLoadedEventEnd, first: fcp?.startTime, phone })], { type: "application/json" }));
    } catch {}
  }, 0));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

  const rows = $("#rows");
  if (rows) {
    const all = () => $$(".row, .card", rows).filter((el) => !el.classList.contains("cover")); // a card's cover is `.cover.card` too
    let items = all();
    const q = $("#q");
    const genre = $("#genre");
    const sort = $("#sort");
    const empty = $("#empty");
    const filters = {}; // chip group -> value
    let years = $$("h2.year", rows);
    // A long list comes with its first rows only; the rest (data-rest of them) is fetched below (pages.twoParts).
    let partial = !!rows.dataset.rest;

    // A long shelf (a catalog of 8000 books) shows its rows a portion at a time: «Показати ще 60 →» adds
    // the next portion (Max, 2026-10-20). Searching or filtering starts again from the first portion.
    const STEP = rows.classList.contains("grid") ? 24 : 60;
    const more = $("#more");
    let limit = STEP;
    let order = items; // the rows as sorted now
    more?.addEventListener("click", () => ((limit += STEP), apply()));
    const again = () => ((limit = STEP), apply());

    function match(it, text, g) {
      if (text && !(it.dataset.search || "").includes(text)) return false;
      // The books on a reader's «Дитяча полиця» are only under that tab.
      if ((filters.status === "kids") !== (it.dataset.kids === "1") && it.dataset.kids !== undefined) return false;
      if (filters.status && filters.status !== "kids") {
        const v = filters.status;
        if (v === "paper") { if (it.dataset.copy !== v) return false; }
        else if (v === "common") { if (it.dataset.common !== "1") return false; }
        else if (it.dataset.status !== v) return false;
      }
      if (filters.genre === "*new") { if (it.dataset.fresh !== "1") return false; } // a publisher's «Нові»
      else if (filters.genre && !(it.dataset.genre || "").split("|").includes(filters.genre)) return false;
      if (filters.avail && it.dataset.avail !== filters.avail) return false;
      if (g && !(it.dataset.tags || "").split("|").includes(g)) return false;
      return true;
    }

    function apply() {
      const text = (q?.value || "").trim().toLowerCase();
      const g = genre?.value || "";
      const matched = order.filter((it) => match(it, text, g));
      const cut = !!more && matched.length > limit + 10;
      let shown = 0;
      const ok = new Set(cut ? matched.slice(0, limit) : matched);
      for (const it of items) it.classList.toggle("hidden", !ok.has(it));
      shown = ok.size;
      if (more) {
        more.parentElement.classList.toggle("hidden", !cut);
        const left = matched.length - limit;
        $("span", more).textContent = left > STEP ? `${STEP} з ${left}` : left;
      }
      $("#capnote")?.classList.toggle("hidden", cut);
      // Year headings only make sense in the import order; hide them when sorting or filtering.
      // Their count is of the rows that pass the filters, not of the whole year («Без дати 1 книжка» under
      // «Покинуто 1», not 100); rows held back by «Показати ще» still count.
      const byOrder = !sort || sort.value === "order";
      const hit = new Set(matched);
      for (const h of years) {
        let next = h.nextElementSibling, any = false, n = 0;
        while (next && !next.matches("h2.year")) {
          if (!next.classList.contains("hidden")) any = true;
          if (hit.has(next)) n += Number(next.dataset.books) || 1; // a series row counts its volumes
          next = next.nextElementSibling;
        }
        h.classList.toggle("hidden", !byOrder || !any);
        const label = $("span", h);
        if (label && !partial) label.textContent = `${n} ${plural(n, "книжка", "книжки", "книжок")}`;
      }
      if (empty) empty.classList.toggle("hidden", shown > 0);
    }

    function resort() {
      const v = sort.value;
      const key = (it) => (v === "rating" ? -(Number(it.dataset.rating) || 0) : v === "title" ? it.dataset.title : Number(it.dataset.order));
      const sorted = [...items].sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0));
      if (v === "order") {
        // Put rows back under their year headings: re-append everything in original DOM order.
        const all = [...years, ...items].sort((a, b) => Number(a.dataset.pos) - Number(b.dataset.pos));
        for (const el of all) rows.appendChild(el);
      } else for (const el of sorted) rows.appendChild(el);
      order = v === "order" ? items : sorted;
      again();
    }

    // Remember the original positions so «за порядком» can restore the year headings.
    // (Rows that come later go after the ones there.)
    let pos = 0;
    const number = () => $$("h2.year, .row, .card", rows).forEach((el) => el.dataset.pos ?? (el.dataset.pos = pos++));
    number();

    q?.addEventListener("input", again);
    genre?.addEventListener("change", again);
    sort?.addEventListener("change", resort);
    // A publisher's genres: four in sight, «ще N» opens the rest; «усі 129» over «Нове» picks «Нові» (2026-11-13).
    for (const btn of $$(".g-more")) btn.addEventListener("click", () => btn.parentElement.classList.add("open"));
    for (const a of $$("[data-pick]")) a.addEventListener("click", () => $$(".tabs[data-filter] .tab").find((t) => t.dataset.v === a.dataset.pick)?.click());
    for (const group of $$(".tabs[data-filter]")) {
      // Tabs with data-param are links (?shelf=read): back and forward in the browser and a shared link
      // show the same tab (Max, 2026-11-08).
      const param = group.dataset.param;
      const pick = (v, push) => {
        const tab = $$(".tab", group).find((c) => c.dataset.v === v) || $(".tab", group);
        $$(".tab", group).forEach((c) => c.classList.toggle("on", c === tab));
        filters[group.dataset.filter] = tab.dataset.v;
        if (push && param) {
          const u = new URL(location.href);
          u.hash = "";
          if (tab.dataset.v) u.searchParams.set(param, tab.dataset.v);
          else u.searchParams.delete(param);
          history.pushState(null, "", u);
        }
        again();
      };
      group.addEventListener("click", (e) => {
        const tab = e.target.closest(".tab");
        if (!tab || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        pick(tab.dataset.v, true);
      });
      if (param) {
        addEventListener("popstate", () => pick(new URL(location.href).searchParams.get(param) || "", false));
        const start = new URL(location.href).searchParams.get(param);
        if (start) pick(start, false);
      }
    }
    if (location.hash === "#want" || location.hash === "#kids") $(`.tab[data-v=${location.hash.slice(1)}]`)?.click();
    // A link to one row (/@maxua#book) must find it even past the first rows, and under «Дитяча полиця» if it is there.
    const toHash = () => {
      const at = location.hash ? order.findIndex((it) => it.id === decodeURIComponent(location.hash.slice(1))) : -1;
      if (at >= 0 && order[at].dataset.kids === "1") $(".tab[data-v=kids]")?.click();
      if (at >= limit) limit = at + STEP;
      return at >= 0;
    };
    const found = toHash();
    apply();
    if (partial) {
      const u = new URL(location.href);
      u.hash = "";
      u.searchParams.set("rest", "");
      const add = (html) => {
        rows.insertAdjacentHTML("beforeend", html);
        items = all();
        years = $$("h2.year", rows);
        partial = false;
        number();
        if (sort && sort.value !== "order") resort();
        else order = items;
        const late = !found && toHash();
        apply();
        if (late) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
      };
      const get = (n) => fetch(u, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then(add, () => n && setTimeout(() => get(n - 1), 3000));
      get(2);
    }
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }

  // Book page: which libraries hold the book, added to «Де взяти» (asked after the page loads; the lookup
  // can take a few seconds).
  const where = $(".where[data-src]");
  if (where) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    fetch(where.dataset.src)
      .then((r) => r.json())
      .then((list) => {
        if (!list.length) return;
        // One row: each city with how many of its libraries have a copy on the shelf now; which ones fold
        // under «які» (2026-10-28 usability review: the branches' addresses came first, the city last).
        const names = (list) => esc(list.length > 4 ? `${list.slice(0, 4).join(", ")} і ще ${list.length - 4}` : list.join(", "));
        const libs = list.map((l) => {
          const by = new Map();
          for (const b of l.records.flatMap((r) => r.branches)) {
            const x = by.get(b.branch) || { total: 0, onShelf: 0, unknown: 0 };
            x.total += b.total;
            x.onShelf += b.onShelf;
            x.unknown += b.unknown || 0;
            by.set(b.branch, x);
          }
          // A library whose branches do not record loans (Kyiv) only says which of them hold a copy.
          const on = [...by].filter(([, x]) => x.onShelf).map(([n]) => n);
          const held = [...by].filter(([, x]) => !x.onShelf && x.unknown).map(([n]) => n);
          return { l, on, held };
        });
        const city = ({ l, on, held }) =>
          `<a href="${esc(l.records[0].url)}" target="_blank" rel="noopener">${esc(l.city)}</a><span class="${on.length ? "ok" : "muted"}">, ${on.length ? `${on.length} на полиці` : held.length ? "є" : "усі видані"}</span>`;
        const detail = ({ l, on, held }) => {
          const parts = [];
          if (on.length) parts.push(`<span class="ok">на полиці</span> <span class="muted">${names(on)}</span>`);
          if (held.length) parts.push(`${on.length ? "також є" : "є"} <span class="muted">${names(held)}</span>`);
          return `<span><a href="${esc(l.records[0].url)}" target="_blank" rel="noopener">${esc(l.name)}</a>: ${parts.length ? parts.join(" · ") : `<span class="muted">усі примірники видані</span>`}</span>`;
        };
        libs.sort((a, b) => b.on.length - a.on.length);
        where.insertAdjacentHTML(
          "beforeend",
          `<div class="where-row"><span class="where-kind">Бібліотеки</span><span class="where-what">${libs.map(city).join(` <span class="muted">·</span> `)} <details class="where-more"><summary>які</summary>${libs.map(detail).join("")}</details></span></div>`
        );
        where.classList.remove("hidden");
      })
      .catch(() => {});
  }

  // Dialogs: delegated, since search results (with «Додати книжку») arrive after the page loads.
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      open.closest("details")?.removeAttribute("open"); // the «⋯» menu it was in
      $("#" + open.dataset.open)?.showModal();
    }
    const close = e.target.closest("[data-close]");
    if (close) close.closest("dialog")?.close();
  });

  // «Клуб Chytai»: «Показати» opens a topic with spoilers (and remembers it for that topic), «відповісти» puts
  // «@username » into the answer, and a topic's book is picked by search as you type.
  document.addEventListener("click", (e) => {
    const un = e.target.closest("[data-unspoil]");
    if (un) {
      const box = un.closest("[data-spoil]");
      box.classList.add("open");
      try { localStorage.setItem("spoil:" + box.dataset.spoil, "1"); } catch {}
    }
    // «змінити» / «Скасувати» under one's own words in the Club.
    const ed = e.target.closest("[data-edit], [data-edit-cancel]");
    if (ed) {
      const box = ed.closest(".cmt");
      const f = box.querySelector(".cmt-edit");
      const on = ed.hasAttribute("data-edit");
      box.querySelector(".txt").hidden = on;
      f.hidden = !on;
      if (on) { const ta = f.querySelector("textarea"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      else f.reset();
    }
    const re = e.target.closest("[data-reply]");
    if (re) {
      const ta = $("#reply textarea");
      if (!ta) return;
      const at = "@" + re.dataset.reply + " ";
      if (!ta.value.includes(at)) ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + " " : ta.value) + at;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  });
  // «@» and «#» in a comment (not a topic's title or text, Max 2026-11-01): who or which book, picked from a short list under the field (Max, 2026-11-01).
  for (const ta of document.querySelectorAll(".cmt-form textarea")) {
    const box = document.createElement("div");
    box.className = "ac-list";
    box.hidden = true;
    ta.insertAdjacentElement("afterend", box);
    const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    let timer, ctrl, token = null, items = [], on = 0;
    const close = () => ((box.hidden = true), (token = null), (items = []));
    const draw = () => {
      box.innerHTML = items.map((x, i) => `<button type="button" class="ac${i === on ? " on" : ""}" data-i="${i}">${x.html}</button>`).join("");
      box.hidden = !items.length;
    };
    const put = (x) => {
      const v = ta.value, end = ta.selectionStart, start = end - token.text.length - 1;
      ta.value = v.slice(0, start) + x.put + " " + v.slice(end);
      const c = start + x.put.length + 1;
      ta.setSelectionRange(c, c);
      ta.focus();
      close();
    };
    ta.addEventListener("input", () => {
      const m = ta.value.slice(0, ta.selectionStart).match(/(?:^|\s)([@#])([^\s@#]{1,40})$/);
      if (!m) return close();
      token = { kind: m[1], text: m[2] };
      clearTimeout(timer);
      timer = setTimeout(async () => {
        ctrl?.abort();
        ctrl = new AbortController();
        const t = token;
        if (!t) return;
        const url = t.kind === "@" ? `/api/club/readers?${new URLSearchParams({ q: t.text })}` : `/api/club/books?${new URLSearchParams({ q: t.text })}`;
        const list = await fetch(url, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : [])).catch(() => null);
        if (!list || token !== t) return;
        items = t.kind === "@"
          ? list.map((r) => ({ put: "@" + r.username, html: `<b>${escH(r.name)}</b> <span class="muted">@${escH(r.username)}</span>` }))
          : list.filter((b) => b.slug).map((b) => ({ put: "#" + b.slug, html: `${b.cover ? `<span class="cover xs"><img src="${escH(b.cover)}" alt="" onerror="this.remove()"></span>` : ""}<span><b>${escH(b.title)}</b> <span class="muted">${escH(b.author)}</span></span>` }));
        on = 0;
        draw();
      }, 150);
    });
    ta.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") (on = (on + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length), draw(), e.preventDefault();
      else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") put(items[on]), e.preventDefault();
      else if (e.key === "Escape") close();
    });
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (b) put(items[+b.dataset.i]);
    });
    ta.addEventListener("blur", () => setTimeout(close, 150));
  }
  // Reactions under a Club answer: sent in the background, the row redrawn from the answer.
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest(".react-form");
    if (!f) return;
    e.preventDefault();
    const bar = f.closest(".reacts");
    const r = await fetch(f.action, { method: "POST", headers: { Accept: "application/json" }, body: new URLSearchParams(new FormData(f)) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (!r) {
      if (f.classList.contains("react-own")) return f.querySelector("input")?.select();
      return f.submit();
    }
    const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    bar.querySelectorAll(":scope > .react-form").forEach((x) => x.remove());
    const add = bar.querySelector(".react-add");
    add?.removeAttribute("open");
    if (add) add.hidden = !!r.full;
    const own = add?.querySelector(".react-own input");
    if (own) own.value = "";
    for (const x of r.reacts) {
      const n = document.createElement("form");
      n.method = "post";
      n.action = f.action;
      n.className = "react-form";
      n.innerHTML = `<input type="hidden" name="emoji" value="${escH(x.emoji)}"><button class="react${x.mine ? " mine" : ""}" title="${escH(x.who.join(", "))}">${escH(x.emoji)} <span>${x.n}</span></button>`;
      bar.insertBefore(n, add);
    }
  });
  // ⌘↵ / Ctrl↵ sends a comment (Max, 2026-11-01).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    const f = e.target.closest?.(".cmt-form, .club-form");
    if (!f || e.target.tagName !== "TEXTAREA" || !e.target.value.trim()) return;
    e.preventDefault();
    f.requestSubmit();
  });
  // «Завантажити й поділитися» (Попросити книжку, 2026-11-08): the chosen file goes up as it is, then the talk reloads.
  for (const f of document.querySelectorAll("[data-ask-upload]")) {
    const input = $('input[type="file"]', f), label = $("label", f), err = $(".error", f);
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const was = label.firstChild.textContent;
      label.firstChild.textContent = "Завантажуємо…";
      err.hidden = true;
      const r = await fetch(`${f.dataset.askUpload}?${new URLSearchParams({ name: file.name })}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }).then((r) => r.json()).catch(() => ({ error: "Файл не дійшов. Спробуйте ще раз." }));
      if (r.go) return location.assign(r.go);
      label.firstChild.textContent = was;
      err.textContent = r.error || "Не вдалося.";
      err.hidden = false;
      input.value = "";
    });
  }
  for (const pick of document.querySelectorAll("[data-book-pick]")) {
    const id = $('input[name="book"]', pick), q = $(".pick-q", pick), hits = $(".pick-hits", pick), picked = $(".picked", pick);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const show = (b) => {
      id.value = b ? b.id : "";
      picked.hidden = !b;
      q.hidden = !!b;
      hits.innerHTML = "";
      if (b) picked.innerHTML = `${b.cover ? `<span class="cover xs"><img src="${esc(b.cover)}" alt="" onerror="this.remove()"></span>` : ""}<span><b>${esc(b.title)}</b><span class="by">${esc(b.author)}</span></span><button type="button" class="text-link small muted" data-unpick>прибрати</button>`;
      else (q.value = ""), q.focus();
    };
    pick.addEventListener("click", (e) => {
      if (e.target.closest("[data-unpick]")) show(null);
      const h = e.target.closest("[data-hit]");
      if (h) show(JSON.parse(h.dataset.hit));
    });
    let timer, ctrl;
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        ctrl?.abort();
        ctrl = new AbortController();
        const list = await fetch(`/api/club/books?${new URLSearchParams({ q: q.value })}`, { signal: ctrl.signal }).then((r) => r.json()).catch(() => null);
        if (!list) return;
        hits.innerHTML = list.map((b) => `<button type="button" class="hit" data-hit="${esc(JSON.stringify(b))}">${b.cover ? `<span class="cover xs"><img src="${esc(b.cover)}" alt="" onerror="this.remove()"></span>` : `<span class="cover xs"></span>`}<span><b>${esc(b.title)}</b><span class="by">${esc(b.author)}</span></span></button>`).join("");
      }, 200);
    });
    q.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
  }

  // «Поділитися» on a list's page: the phone's own share sheet, else the address goes to the clipboard.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-share]");
    if (!b) return;
    const url = b.dataset.share;
    try {
      if (navigator.share) return await navigator.share({ title: b.dataset.title || document.title, url });
      await navigator.clipboard.writeText(url);
      const was = b.textContent;
      b.textContent = "Посилання скопійовано";
      setTimeout(() => (b.textContent = was), 2000);
    } catch {}
  });

  // Phones: «Меню» opens the navigation and the search.
  const top = $("header.top");
  $(".menu", top)?.addEventListener("click", (e) => {
    const open = top.classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", open);
    if (open) $(".find input", top)?.focus();
  });

  // Homepage: «Ще одну →» shows the next random book, round and round.
  const picks = $$(".pick");
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-next-pick]")) return;
    const i = picks.findIndex((p) => !p.classList.contains("hidden"));
    picks[i].classList.add("hidden");
    picks[(i + 1) % picks.length].classList.remove("hidden");
  });
  // Homepage: the seed switch above the recommendations (each seed has its own block).
  const recs = $$(".rec[data-seed]");
  for (const b of $$(".rec .tab[data-seed]"))
    b.addEventListener("click", () => {
      for (const r of recs) r.classList.toggle("hidden", r.dataset.seed !== b.dataset.seed);
      for (const t of $$(".rec .tab[data-seed]")) t.classList.toggle("on", t.dataset.seed === b.dataset.seed);
    });

  // A text switch that marks itself on and calls back with its value.
  const switches = (group, fn) =>
    group?.addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (!tab) return;
      $$(".tab", group).forEach((t) => t.classList.toggle("on", t === tab));
      fn(tab.dataset.v);
    });
  // /community: the feed's filter (everything, the readers one follows, with notes, rated 4,5 and up).
  switches($("[data-feed-filter]"), (v) => {
    for (const row of $$(".feed-row")) row.classList.toggle("hidden", (v === "followed" && !row.classList.contains("followed")) || (v === "notes" && !row.classList.contains("noted")) || (v === "top" && !(Number(row.dataset.rating) >= 4.5)));
  });
  // /publishers: by new books or by name.
  const pubs = $(".pubs");
  switches($("[data-sort-pubs]"), (v) => {
    const rows = $$(".pub", pubs).sort((a, b) => (v === "name" ? a.dataset.name.localeCompare(b.dataset.name, "uk") : b.dataset.fresh - a.dataset.fresh));
    for (const r of rows) pubs.appendChild(r);
  });

  // Search as you type: results replace #live (and hide #browse on the homepage) after a short pause.
  // The results have their own address, /search?q=… (Max, 2026-10-20), so they can be shared and
  // survive a refresh: on /search itself the address follows the box; elsewhere (the homepage, the
  // header box on other pages) the first word typed adds /search?q=… to the history, so «Назад»
  // returns to the page the search started from, and clearing the box goes back there too.
  // A search no book here answers: the books that exist elsewhere come a moment later (/api/search/outside).
  const outside = (root) => {
    for (const el of $$(".outside[data-src]", root)) {
      const src = el.dataset.src;
      el.removeAttribute("data-src");
      // Asked only once the reader stops typing: a word still being typed would ask Google for every pause.
      setTimeout(() => {
        if (!el.isConnected) return;
        fetch(src)
          .then((r) => (r.ok ? r.text() : ""))
          .then((html) => (el.innerHTML = html))
          .catch(() => (el.innerHTML = ""));
      }, root === document ? 0 : 900);
    }
  };
  outside(document);
  const liveSearch = (box, live, browse) => {
    const input = $("input, textarea", box);
    // The homepage's box (a textarea, one line that grows) also takes a request in one's own words (intent.js):
    // the results then start with «Порадити книжки», and Enter presses it.
    const big = input.tagName === "TEXTAREA";
    // «Порадити книжки ↵» in the field and the line under it follow the results: a request puts body.asking on.
    // «Шукати як назву» turns it off for these words (`plain`), until they change.
    let plain = false;
    const askIn = $(".ask-in", box);
    // The button narrows the field: its height is measured again.
    const asking = () => big && (document.body.classList.toggle("asking", !!$("form[data-primary]", live)), grow());
    if (askIn) askIn.hidden = false;
    askIn?.addEventListener("click", () => box.requestSubmit());
    for (const b of $$("[data-plain]")) b.addEventListener("click", () => ((plain = true), (last = null), run(), input.focus()));
    if (big) input.addEventListener("input", () => (plain = false));
    const grow = () => ((input.style.height = "auto"), (input.style.height = `${input.scrollHeight}px`));
    if (big) {
      grow();
      input.addEventListener("input", grow);
      input.addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), box.requestSubmit()));
    }
    const onSearch = location.pathname === "/search";
    const home = { url: location.href, title: document.title };
    let timer, ctrl, pushed = false, last = onSearch ? input.value.trim() : "";
    // The query the reader stopped at goes to the search log once (admin.searched): after a few seconds without
    // typing, or when they leave for a result. The pauses in between are not counted.
    let pending = "", logged = onSearch ? last : "", logTimer;
    const flush = () => {
      clearTimeout(logTimer);
      // A request went to /ask (it keeps its own); only searches are counted here.
      if (pending && pending !== logged && !$("[data-primary]", live)) navigator.sendBeacon?.("/api/searched", new URLSearchParams({ q: pending }));
      logged = pending || logged;
      pending = "";
    };
    addEventListener("pagehide", flush);
    live.addEventListener("click", (e) => e.target.closest("a") && flush());
    const show = (q) => {
      for (const el of browse) el.hidden = !!q;
      if (!q) {
        if (onSearch) history.replaceState(null, "", "/search");
        else if (pushed) (pushed = false), history.back();
        document.title = onSearch ? "Пошук · Chytai" : home.title;
        return;
      }
      const url = `/search?${new URLSearchParams({ q })}`;
      if (onSearch || pushed) history.replaceState({ q }, "", url);
      else (pushed = true), history.pushState({ q }, "", url);
      document.title = `${q} · Пошук · Chytai`;
    };
    const run = async () => {
      const q = input.value.trim();
      if (q === last) return;
      last = q;
      ctrl?.abort();
      if (!q) return (live.innerHTML = ""), show("");
      ctrl = new AbortController();
      try {
        const r = await fetch(`/api/search?${new URLSearchParams(big ? { q, home: 1, ...(plain ? { plain: 1 } : {}) } : { q })}`, { signal: ctrl.signal });
        live.innerHTML = await r.text();
        asking();
        outside(live);
        show(q);
        clearTimeout(logTimer);
        pending = q;
        logTimer = setTimeout(flush, 3000);
      } catch (e) {
        if (e.name !== "AbortError") box.submit();
      }
    };
    // «Назад» from the results to the page they started on, or «Вперед» back to them.
    if (!onSearch)
      addEventListener("popstate", (e) => {
        const q = location.pathname === "/search" ? new URLSearchParams(location.search).get("q") || "" : "";
        pushed = !!q;
        input.value = q;
        last = null;
        run();
      });
    input.addEventListener("input", () => (clearTimeout(timer), (timer = setTimeout(run, 180))));
    box.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearTimeout(timer);
      last = null;
      await run();
      $("form[data-primary]", live)?.requestSubmit();
    });
    // «Можна й своїми словами: «…»»: the example goes into the box.
    for (const b of $$("[data-fill]")) b.addEventListener("click", () => ((input.value = b.dataset.fill), big && grow(), input.focus(), (last = null), run()));
    return { input, run: () => ((last = null), run()) };
  };
  const box = $("form.search-box");
  const live = $("#live");
  if (box && live) liveSearch(box, live, $$("#browse"));
  if (box && live && $("textarea", box)) document.body.classList.toggle("asking", !!$("form[data-primary]", live));
  const find = $("header form.find");
  const main = $("main");
  if (find && main) {
    const results = document.createElement("div");
    results.className = "find-results";
    results.dataset.block = "search";
    main.prepend(results);
    liveSearch(find, results, [...main.children].filter((el) => el !== results));
  }

  document.addEventListener("submit", (e) => {
    const b = e.target.matches?.(".ask-go, .ask-go-line") && e.target.querySelector("button");
    if (b) setTimeout(() => ((b.disabled = true), (b.textContent = "Добираю книжки…")));
    const inField = e.target.matches?.("[data-primary]") && $(".ask-in");
    if (inField) setTimeout(() => ((inField.disabled = true), (inField.textContent = "Добираю…")));
  });
  // «Хочу прочитати», «Прочитано», «Стежити», «Підписатися» in a list: sent in the background and changed
  // in place, so the page doesn't jump to the top after the server's redirect (Max, 2026-10-20). Without
  // JS (or when the request fails) the form posts as before. The book page's own buttons still reload it.
  const LABEL = { want: "хочу прочитати", read: "прочитано", reading: "читаю", abandoned: "покинуто" };
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    const action = form.getAttribute("action") || "";
    if (form.method !== "post" || !/^\/api\/(entry|follow|subscribe)\//.test(action) || form.closest(".book-main")) return;
    e.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      const r = await fetch(action, { method: "POST", body: new URLSearchParams(new FormData(form)), credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
    } catch {
      return form.submit();
    }
    if (button) button.disabled = false;
    const status = form.querySelector("input[name=status]")?.value;
    if (action.startsWith("/api/entry/") && status === "read" && form.closest(".marks")) {
      form.closest(".marks").replaceWith(rateLine(decodeURIComponent(action.slice("/api/entry/".length))));
      return;
    }
    if (action.startsWith("/api/entry/") && status) {
      const mark = document.createElement("span");
      mark.className = "muted small";
      mark.textContent = LABEL[status] || "на полиці";
      (form.closest(".marks") || form).replaceWith(mark);
      return;
    }
    if (!button) return;
    const on = !button.classList.contains("on") && !/^✓/.test(button.textContent);
    button.classList.toggle("on", on);
    if (action.startsWith("/api/follow/")) button.textContent = on ? "✓ Стежу" : "Стежити";
    else if (button.classList.contains("text-link")) button.textContent = on ? "✓ підписано" : "підписатися";
    else {
      button.textContent = on ? "✓ Підписано" : "Підписатися";
      if (on) button.classList.remove("primary");
    }
  });

  // Stars and the year after «Прочитано» on someone else's shelf (pages.js rateLine): each tap is saved
  // in the background; the stars stay lit up to the chosen one and can be changed.
  const rateLine = (id) => {
    const el = document.createElement("span");
    el.className = "rate";
    el.dataset.id = id;
    const year = new Date().getFullYear();
    el.innerHTML = `<span class="muted small">прочитано</span><span class="rate-stars" role="group" aria-label="Оцінка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-r="${n}" title="${n} з 5">★</button>`).join("")}</span><select class="rate-year" aria-label="Рік"><option value="">рік?</option>${Array.from({ length: 10 }, (_, i) => `<option>${year - i}</option>`).join("")}</select>`;
    return el;
  };
  const saveRate = async (box, field, value) => {
    box.classList.add("saving");
    try {
      const r = await fetch(`/api/entry/${encodeURIComponent(box.dataset.id)}`, { method: "POST", body: new URLSearchParams({ [field]: value, ...(box.dataset.status ? { status: box.dataset.status } : {}), back: "1" }), credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
      box.classList.remove("failed");
    } catch {
      box.classList.add("failed");
    }
    box.classList.remove("saving");
  };
  document.addEventListener("click", (e) => {
    const star = e.target.closest(".rate-stars button");
    if (!star) return;
    const box = star.closest(".rate");
    // A second tap on the same star makes it half (4 → 4,5 is two taps on the fifth), a third makes it whole
    // again (Max, 2026-10-30: «перший тап повна зірка, другий тап половинка»).
    const r = Number(star.dataset.r);
    const n = Number(box.dataset.rating) === r ? r - 0.5 : r;
    box.dataset.rating = n;
    for (const b of box.querySelectorAll(".rate-stars button")) {
      b.classList.toggle("on", Number(b.dataset.r) <= n);
      b.classList.toggle("half", Number(b.dataset.r) === n + 0.5);
    }
    // /start (pages.startPage): the count of rated books, and «Що читати далі» once there are enough.
    const start = !box.classList.contains("rated") && box.closest("[data-start]");
    if (start) {
      const k = Number(start.dataset.rated) + 1;
      start.dataset.rated = k;
      const goal = Number(start.dataset.goal);
      const out = start.querySelector("[data-start-n]");
      if (out) out.textContent = `${Math.min(k, goal)} з ${goal}`;
      start.querySelectorAll(".start-dots i").forEach((d, i) => d.classList.toggle("on", i < k));
      const go = start.querySelector("[data-start-done]");
      if (go && k >= goal) go.classList.remove("off"), go.removeAttribute("aria-disabled"), go.removeAttribute("tabindex");
    }
    box.classList.add("rated");
    saveRate(box, "rating", n);
  });
  document.addEventListener("change", (e) => {
    const year = e.target.closest(".rate-year");
    if (year) saveRate(year.closest(".rate"), "year", year.value);
  });

  // «Покинуто» chosen: the note asks why, quietly (pages.js WHY).
  for (const form of $$(".entry-form")) {
    const status = form.querySelector("select[name=status]");
    const note = form.querySelector("textarea[name=note]");
    const plain = "Кілька слів про книжку";
    status.addEventListener("change", () => (note.placeholder = status.value === "abandoned" ? note.dataset.why : plain));
    // «Читаю зараз» belongs to «Читаю» only: it hides as soon as another status is picked (Max, 2026-11-03).
    const now = form.parentElement.querySelector(".now-line");
    if (now) status.addEventListener("change", () => (now.hidden = status.value !== "reading"));
  }

  // An empty «Рік» («без дати») would start its arrows from the minimum (1940), so this year becomes
  // the value first (a reader's feedback, 2026-10-20).
  for (const year of $$("input[name=year]")) {
    const fill = () => { if (!year.value) year.value = new Date().getFullYear(); };
    year.addEventListener("pointerdown", (e) => e.offsetX > year.clientWidth - 28 && fill()); // the arrows, not the text
    year.addEventListener("keydown", (e) => (e.key === "ArrowUp" || e.key === "ArrowDown") && fill());
    year.addEventListener("wheel", fill, { passive: true });
  }
})();
// «Чи варто мені читати?» and «Що кажуть про цю книжку?» on a book page: the link asks Claude and the
// answer takes its place (data-ask names the API: advice is per reader, overview per book).
document.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-ask]");
  const block = button?.closest(".advice");
  if (!block) return;
  const kind = button.dataset.ask;
  const body = block.querySelector(".advice-body");
  const was = body.innerHTML;
  // The wait is long (a web search takes 15–40 s), so the line changes every few seconds (Max, 2026-10-23); in the first person (Max, 2026-11-07).
  const steps = kind === "overview"
    ? ["Шукаю відгуки в інтернеті…", "Читаю, що пишуть читачі…", "Дивлюсь рецензії…", "Збираю, в чому сходяться думки…", "Пишу коротко своїми словами…", "Ще трохи…"]
    : ["Читаю вашу полицю…", "Порівнюю з тим, що ви читали…", "Пишу…", "Ще трохи…"];
  let step = 0;
  body.innerHTML = `<p class="advice-wait">${steps[0]}</p>`;
  const ticker = setInterval(() => {
    const p = body.querySelector(".advice-wait");
    if (p) p.textContent = steps[Math.min(++step, steps.length - 1)];
  }, kind === "overview" ? 5000 : 3500);
  try {
    const r = await fetch(`/api/${kind}/${encodeURIComponent(block.dataset.book)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(button.hasAttribute("data-again") ? { fresh: "1" } : {}) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    clearInterval(ticker);
    body.innerHTML = data.html;
  } catch (err) {
    clearInterval(ticker);
    body.innerHTML = was;
    const p = document.createElement("p");
    p.className = "advice-error small";
    p.textContent = err.message === "Failed to fetch" ? "Немає звʼязку, спробуйте ще раз." : err.message;
    body.append(p);
  }
});
// «Читати далі» under a folded overview: the whole text, the link goes away.
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-unfold]");
  const block = button?.closest(".advice");
  if (!block) return;
  block.querySelector(".advice-text")?.classList.remove("folded");
  button.closest(".advice-more")?.remove();
});
// The «⋯» and status «▾» menus on book pages close on a tap outside them or on Escape; one open at a time.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.more-acts[open]")) if (!d.contains(e.target)) d.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const d of document.querySelectorAll("details.more-acts[open]")) d.open = false;
});
// Taps for /admin/traffic «Що натискають» (Max, 2026-10-29: «норм інструментацію … щоб мати дані для продуктових
// рішень»): the kind of page, the block the tap was in (data-block), what it led to and, for a book in a row, its
// place there. The server only counts them per day (admin.tap): no id, no address beyond the kind of page.
(() => {
  const send = (url, data) => {
    try {
      navigator.sendBeacon?.(url, new URLSearchParams({ path: location.pathname, ...data }));
    } catch {}
  };
  const clean = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  const target = (el) => {
    if (el.dataset.ev) return el.dataset.ev;
    if (el.matches("summary")) return el.closest(".more-acts") ? "menu" : "open";
    if (el.tagName === "A") {
      let u;
      try {
        u = new URL(el.href, location.href);
      } catch {
        return "";
      }
      if (u.origin !== location.origin) return /(^|\.)app\.chytai\.org\.ua$/.test(u.hostname) ? "reader-app" : u.protocol === "mailto:" ? "mail" : `out:${u.hostname.replace(/^www\./, "")}`;
      const go = /^\/go\/([a-z]+)\//.exec(u.pathname);
      if (go) return `go:${go[1]}`;
      if (u.pathname.startsWith("/login")) {
        const d = /\/do\/(want|read|reading|now|kids|paper)\//.exec(decodeURIComponent(u.search));
        return d ? `guest:${d[1]}` : "login";
      }
      if (u.pathname.startsWith("/@")) return "reader";
      return clean(u.pathname.split("/")[1]) || "home";
    }
    if (el.dataset.r) return "stars";
    const f = el.form || el.closest("form");
    if (!f) return "button";
    const a = f.getAttribute("action") || "";
    if (a.startsWith("/login")) return ""; // the way in is counted on the server, step by step
    if (/\/api\/entry\/.*\/remove$/.test(a)) return "remove";
    if (/\/api\/entry\//.test(a)) return f.querySelector("[name=status]")?.value || (f.querySelector("[name=kids]") ? "kids" : "entry");
    if (/\/api\/now\//.test(a)) return "now";
    return `form:${clean(a.split("/").filter(Boolean).slice(0, 2).join("-"))}`;
  };
  const bucket = (i) => (i < 4 ? String(i) : i <= 6 ? "4-6" : i <= 10 ? "7-10" : "11+");
  document.addEventListener("click", (e) => {
    const el = e.target.closest("a[href], button, summary, [data-ev]");
    if (!el || el.closest("[data-no-tap]")) return;
    const what = target(el);
    if (!what) return;
    const box = el.closest("[data-block]");
    const block = box ? box.dataset.block : el.closest("header") ? "header" : el.closest("footer") ? "footer" : "-";
    let pos = "";
    if (what === "book" && box) {
      const hrefs = [...new Set([...box.querySelectorAll('a[href^="/book/"]')].map((a) => a.getAttribute("href")))];
      const i = hrefs.indexOf(el.getAttribute("href"));
      if (i >= 0) pos = bucket(i + 1);
    }
    send("/api/tap", { block, target: what, pos });
  }, true);
  // Script errors, a few per page, for /admin/speed: nobody writes in about a button that quietly does nothing.
  let errors = 0;
  addEventListener("error", (e) => {
    if (errors++ < 3 && e.message) send("/api/js-error", { message: `${e.message} (${String(e.filename || "").split("/").pop().split("?")[0]}:${e.lineno || 0})` });
  });
})();
