// Client side of the web platform: filtering and sorting of the library and shelf lists, dialogs.
// Everything else is plain forms handled by the server.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const rows = $("#rows");
  if (rows) {
    const items = $$(".row, .card", rows);
    const q = $("#q");
    const genre = $("#genre");
    const sort = $("#sort");
    const empty = $("#empty");
    const filters = {}; // chip group -> value
    const years = $$("h2.year", rows);

    function apply() {
      const text = (q?.value || "").trim().toLowerCase();
      const g = genre?.value || "";
      let shown = 0;
      for (const it of items) {
        let ok = true;
        if (text && !it.dataset.search.includes(text)) ok = false;
        if (ok && filters.status) {
          const v = filters.status;
          if (v === "paper" || v === "seeking") ok = it.dataset.copy === v;
          else ok = it.dataset.status === v;
        }
        if (ok && filters.genre) ok = it.dataset.genre.split("|").includes(filters.genre);
        if (ok && filters.avail) ok = it.dataset.avail === filters.avail;
        if (ok && g) ok = it.dataset.tags.split(" ").includes(g);
        it.classList.toggle("hidden", !ok);
        if (ok) shown++;
      }
      // Year headings only make sense in the import order; hide them when sorting or filtering.
      const byOrder = !sort || sort.value === "order";
      for (const h of years) {
        let next = h.nextElementSibling, any = false;
        while (next && !next.matches("h2.year")) {
          if (!next.classList.contains("hidden")) { any = true; break; }
          next = next.nextElementSibling;
        }
        h.classList.toggle("hidden", !byOrder || !any);
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
      apply();
    }

    // Remember the original positions so «за порядком» can restore the year headings.
    $$("h2.year, .row, .card", rows).forEach((el, i) => (el.dataset.pos = i));

    q?.addEventListener("input", apply);
    genre?.addEventListener("change", apply);
    sort?.addEventListener("change", resort);
    for (const group of $$(".chips[data-filter]")) {
      group.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        $$(".chip", group).forEach((c) => c.classList.toggle("on", c === chip));
        filters[group.dataset.filter] = chip.dataset.v;
        apply();
      });
    }
    if (location.hash === "#want") $(".chip[data-v=want]")?.click();
  }

  // Book page: which libraries hold the book (asked after the page loads; the lookup can take a few seconds).
  const libs = $(".libs[data-src]");
  if (libs) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    fetch(libs.dataset.src)
      .then((r) => r.json())
      .then((list) => {
        if (!list.length) return;
        // One line per library: where a copy is on the shelf now, or that all are out.
        $(".libs-list", libs).innerHTML = list
          .map((l) => {
            const by = new Map();
            for (const b of l.records.flatMap((r) => r.branches)) {
              const x = by.get(b.branch) || { total: 0, onShelf: 0 };
              x.total += b.total;
              x.onShelf += b.onShelf;
              by.set(b.branch, x);
            }
            const on = [...by].filter(([, x]) => x.onShelf).map(([n]) => n);
            const where = on.length ? `<span class="ok">є на полиці:</span> ${esc(on.join(", "))}` : `<span class="muted">усі примірники видані</span>`;
            return `<p class="lib"><a href="${esc(l.records[0].url)}" target="_blank" rel="noopener"><b>${esc(l.name)}</b> ↗</a> <span class="muted small">${esc(l.city)}</span><br>${where}</p>`;
          })
          .join("");
        libs.classList.remove("hidden");
      })
      .catch(() => {});
  }

  for (const b of $$("[data-open]")) b.addEventListener("click", () => $("#" + b.dataset.open)?.showModal());
  for (const b of $$("[data-close]")) b.addEventListener("click", () => b.closest("dialog")?.close());
})();
