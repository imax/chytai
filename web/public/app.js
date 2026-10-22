// Client side of the web platform: filtering and sorting of the shelves and catalogs, dialogs, the
// menu on phones, the switches of the homepage, /community and /publishers.
// Everything else is plain forms handled by the server.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

  const rows = $("#rows");
  if (rows) {
    const items = $$(".row, .card", rows);
    const q = $("#q");
    const genre = $("#genre");
    const sort = $("#sort");
    const empty = $("#empty");
    const filters = {}; // chip group -> value
    const years = $$("h2.year", rows);

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
      if (filters.status) {
        const v = filters.status;
        if (v === "paper" || v === "seeking") { if (it.dataset.copy !== v) return false; }
        else if (v === "common") { if (it.dataset.common !== "1") return false; }
        else if (it.dataset.status !== v) return false;
      }
      if (filters.genre && !(it.dataset.genre || "").split("|").includes(filters.genre)) return false;
      if (filters.avail && it.dataset.avail !== filters.avail) return false;
      if (g && !(it.dataset.tags || "").split(" ").includes(g)) return false;
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
      // Year headings only make sense in the import order; hide them when sorting or filtering.
      // Their count is of the rows that pass the filters, not of the whole year («Без дати 1 книжка» under
      // «Покинуто 1», not 100); rows held back by «Показати ще» still count.
      const byOrder = !sort || sort.value === "order";
      const hit = new Set(matched);
      for (const h of years) {
        let next = h.nextElementSibling, any = false, n = 0;
        while (next && !next.matches("h2.year")) {
          if (!next.classList.contains("hidden")) any = true;
          if (hit.has(next)) n++;
          next = next.nextElementSibling;
        }
        h.classList.toggle("hidden", !byOrder || !any);
        const label = $("span", h);
        if (label) label.textContent = `${n} ${plural(n, "книжка", "книжки", "книжок")}`;
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
    $$("h2.year, .row, .card", rows).forEach((el, i) => (el.dataset.pos = i));

    q?.addEventListener("input", again);
    genre?.addEventListener("change", again);
    sort?.addEventListener("change", resort);
    for (const group of $$(".tabs[data-filter]")) {
      group.addEventListener("click", (e) => {
        const tab = e.target.closest(".tab");
        if (!tab) return;
        $$(".tab", group).forEach((c) => c.classList.toggle("on", c === tab));
        filters[group.dataset.filter] = tab.dataset.v;
        again();
      });
    }
    if (location.hash === "#want") $(".tab[data-v=want]")?.click();
    // A link to one row (/@maxua#book) must find it even past the first rows.
    const at = location.hash ? order.findIndex((it) => it.id === decodeURIComponent(location.hash.slice(1))) : -1;
    if (at >= limit) limit = at + STEP;
    apply();
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
        // One item per library: where a copy is on the shelf now, or that all are out.
        where.insertAdjacentHTML(
          "beforeend",
          list
            .map((l) => {
              const by = new Map();
              for (const b of l.records.flatMap((r) => r.branches)) {
                const x = by.get(b.branch) || { total: 0, onShelf: 0, unknown: 0 };
                x.total += b.total;
                x.onShelf += b.onShelf;
                x.unknown += b.unknown || 0;
                by.set(b.branch, x);
              }
              // A library whose branches do not record loans (Kyiv) only says which of them hold a copy.
              const names = (list) => esc(list.length > 4 ? `${list.slice(0, 4).join(", ")} і ще ${list.length - 4}` : list.join(", "));
              const on = [...by].filter(([, x]) => x.onShelf).map(([n]) => n);
              const held = [...by].filter(([, x]) => !x.onShelf && x.unknown).map(([n]) => n);
              const parts = [];
              if (on.length) parts.push(`<span class="ok">є на полиці</span> <span class="muted">${names(on)}</span>`);
              if (held.length) parts.push(`${on.length ? "також є" : "є"} <span class="muted">${names(held)}</span>`);
              const state = parts.length ? parts.join(" · ") : `<span class="muted">усі примірники видані</span>`;
              return `<span class="where-item">${state} · <a href="${esc(l.records[0].url)}" target="_blank" rel="noopener">${esc(l.name)}</a><span class="muted">, ${esc(l.city)}</span></span>`;
            })
            .join("")
        );
        where.classList.remove("hidden");
      })
      .catch(() => {});
  }

  // Dialogs: delegated, since search results (with «Додати книжку») arrive after the page loads.
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) $("#" + open.dataset.open)?.showModal();
    const close = e.target.closest("[data-close]");
    if (close) close.closest("dialog")?.close();
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
  const liveSearch = (box, live, browse) => {
    const input = $("input", box);
    const onSearch = location.pathname === "/search";
    const home = { url: location.href, title: document.title };
    let timer, ctrl, pushed = false, last = onSearch ? input.value.trim() : "";
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
        const r = await fetch(`/api/search?${new URLSearchParams({ q })}`, { signal: ctrl.signal });
        live.innerHTML = await r.text();
        show(q);
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
    box.addEventListener("submit", (e) => (e.preventDefault(), clearTimeout(timer), (last = null), run()));
    return { input, run: () => ((last = null), run()) };
  };
  const box = $("form.search-box");
  const live = $("#live");
  if (box && live) liveSearch(box, live, $$("#browse"));
  const find = $("header form.find");
  const main = $("main");
  if (find && main) {
    const results = document.createElement("div");
    results.className = "find-results";
    main.prepend(results);
    liveSearch(find, results, [...main.children].filter((el) => el !== results));
  }

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

  // «Покинуто» chosen: the note asks why, quietly (pages.js WHY).
  for (const form of $$(".entry-form")) {
    const status = form.querySelector("select[name=status]");
    const note = form.querySelector("textarea[name=note]");
    const plain = "Кілька слів про книжку";
    status.addEventListener("change", () => (note.placeholder = status.value === "abandoned" ? note.dataset.why : plain));
  }

  // An empty «Рік» («без дати») would start its arrows from the minimum (1990), so this year becomes
  // the value first (a reader's feedback, 2026-10-20).
  for (const year of $$("input[name=year]")) {
    const fill = () => { if (!year.value) year.value = new Date().getFullYear(); };
    year.addEventListener("pointerdown", (e) => e.offsetX > year.clientWidth - 28 && fill()); // the arrows, not the text
    year.addEventListener("keydown", (e) => (e.key === "ArrowUp" || e.key === "ArrowDown") && fill());
    year.addEventListener("wheel", fill, { passive: true });
  }
})();