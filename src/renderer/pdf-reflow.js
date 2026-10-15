/* global JSZip */
// Turns a text PDF into a reflowable EPUB so it gets the same typography as real e-books.
// Heuristic: rebuild lines from positioned text, drop running headers/page numbers,
// join lines into paragraphs, mark larger text as headings, split chapters by the outline.
// Pages of verse keep their line breaks: a poem reflowed into prose is unreadable.

export const REFLOW_VERSION = 3;
const PAGES_PER_SECTION = 20;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const TERMINAL = /[.!?…:;"”’»)\]]$/;

// Positioned text items -> lines (top to bottom), each { text, x, xEnd, y, size }.
function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , d, x, y] = it.transform;
    const size = Math.hypot(b, d) || Math.abs(a) || it.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < size * 0.4);
    if (!row) rows.push((row = { y, size, parts: [] }));
    row.parts.push({ x, xEnd: x + it.width, str: it.str, size });
    row.size = Math.max(row.size, size);
  }
  rows.sort((r1, r2) => r2.y - r1.y);
  return rows.map((r) => {
    r.parts.sort((p1, p2) => p1.x - p2.x);
    let text = "";
    let lastEnd = null;
    for (const p of r.parts) {
      if (lastEnd !== null && p.x - lastEnd > p.size * 0.2 && !text.endsWith(" ") && !p.str.startsWith(" ")) text += " ";
      text += p.str;
      lastEnd = p.xEnd;
    }
    return {
      text: text.replace(/\s+/g, " ").trim(),
      x: r.parts[0].x,
      xEnd: r.parts[r.parts.length - 1].xEnd,
      y: r.y,
      size: r.size,
    };
  });
}

// Normalised form for spotting running headers/footers that repeat across pages.
const furnitureKey = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const isPageNumber = (t) => /^[\divxlcdm\s.\-–—]+$/i.test(t) && t.length <= 12;

// Small bare numbers next to body text are line numbers of a poem or footnote marks.
function dropMarginNumbers(items) {
  const sizes = items.filter((it) => it.str?.trim()).map((it) => Math.hypot(it.transform[1], it.transform[3]));
  const body = median(sizes);
  return items.filter((it) => !(/^\s*\d+\s*$/.test(it.str || "") && Math.hypot(it.transform[1], it.transform[3]) < body * 0.7));
}

async function readPages(doc, onProgress) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ n, height, lines: toLines(dropMarginNumbers(content.items)) });
    page.cleanup();
    if (n % 10 === 0) onProgress?.(n, doc.numPages);
  }
  return pages;
}

function dropFurniture(pages) {
  const counts = new Map();
  for (const p of pages) {
    const edge = [...p.lines.slice(0, 2), ...p.lines.slice(-2)];
    for (const l of new Set(edge.map((l) => furnitureKey(l.text)))) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const minRepeats = Math.max(3, pages.length * 0.15);
  for (const p of pages) {
    const isEdge = (l) => l.y > p.height * 0.9 || l.y < p.height * 0.1;
    p.lines = p.lines.filter((l, i) => {
      const nearEdge = i < 2 || i >= p.lines.length - 2;
      if (!nearEdge || !isEdge(l)) return true;
      if (isPageNumber(l.text)) return false;
      return (counts.get(furnitureKey(l.text)) || 0) < minRepeats;
    });
  }
}

// Verse: a run of lines that share a left edge where many stop well short of the margin
// (in prose only the last line of a paragraph is short, and the next one is indented).
// Marks such lines with `verse`, so a poem quoted inside prose is caught too.
function markVerse(lines, bodySize, lineGap) {
  const body = lines.filter((l) => l.size <= bodySize * 1.2);
  if (body.length < 3) return;
  const left = Math.min(...body.map((l) => l.x));
  const right = Math.max(...body.map((l) => l.xEnd));
  const width = right - left || 1;
  const short = (l) => l.xEnd < right - width * 0.12;
  const runs = [];
  let run = null;
  lines.forEach((l, i) => {
    if (l.size > bodySize * 1.2) return void (run = null); // headings end a run
    const prev = lines[i - 1];
    const joins = run && prev.y - l.y <= lineGap * 1.45 && Math.abs(l.x - prev.x) < bodySize * 0.5;
    if (!joins) runs.push((run = []));
    run.push(l);
  });
  const verseX = [];
  for (const r of runs) {
    const soft = r.slice(0, -1).filter(short).length;
    if (r.length >= 3 && soft >= Math.max(2, (r.length - 1) * 0.3)) {
      r.forEach((l) => (l.verse = true));
      verseX.push(r[0].x);
    }
  }
  // Short stanzas and single speech lines between verse runs.
  for (const r of runs) {
    if (r.length < 3 && r.every((l) => l.xEnd < right - width * 0.05) && verseX.some((x) => Math.abs(x - r[0].x) < bodySize * 0.5)) {
      r.forEach((l) => (l.verse = true));
    }
  }
}

// Lines across all pages -> blocks { type: "p"|"h", text, page } or { type: "v", lines, page }.
function toBlocks(pages) {
  let all = pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.n })));
  const bodySize = median(all.map((l) => l.size));
  const left = median(all.map((l) => l.x));
  const right = median(all.map((l) => l.xEnd));
  const width = right - left || 1;
  const gaps = [];
  for (const p of pages) for (let i = 1; i < p.lines.length; i++) gaps.push(p.lines[i - 1].y - p.lines[i].y);
  const lineGap = median(gaps.filter((g) => g > 0)) || bodySize * 1.2;
  for (const p of pages) markVerse(p.lines, bodySize, lineGap);
  all = pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.n })));

  const blocks = [];
  let cur = null;
  let prev = null;
  const flush = () => cur && blocks.push(cur) && (cur = null);

  for (const l of all) {
    const heading = l.size > bodySize * 1.2 && l.text.length < 120;
    const samePage = prev && prev.page === l.page;
    const bigGap = samePage && prev.y - l.y > lineGap * 1.45;
    const indented = l.x > left + bodySize * 0.8 && l.x < left + width * 0.3;
    const prevShort = prev && prev.xEnd < right - width * 0.12 && TERMINAL.test(prev.text);
    const prevEnded = prev && TERMINAL.test(prev.text);

    if (heading) {
      if (cur?.type === "h" && samePage && !bigGap) {
        cur.text += " " + l.text;
      } else {
        flush();
        cur = { type: "h", text: l.text, page: l.page };
      }
    } else if (l.verse) {
      const wrapped = cur?.type === "v" && samePage && !bigGap && indented && prev.xEnd > right - width * 0.05;
      if (wrapped) {
        cur.lines[cur.lines.length - 1] += " " + l.text; // a long verse line the PDF wrapped
      } else if (cur?.type === "v" && !bigGap) {
        cur.lines.push(l.text);
      } else {
        flush();
        cur = { type: "v", lines: [l.text], page: l.page };
      }
    } else if (!cur || cur.type !== "p" || bigGap || indented || prevShort || (!samePage && prevEnded && prev.xEnd < right - width * 0.05)) {
      flush();
      cur = { type: "p", text: l.text, page: l.page };
    } else if (/[A-Za-zА-Яа-яЁёЇїІіЄєҐґ]-$/.test(cur.text) && /^[a-zа-яёїієґ]/.test(l.text)) {
      cur.text = cur.text.slice(0, -1) + l.text; // re-join a word hyphenated at the line end
    } else {
      cur.text += " " + l.text;
    }
    prev = l;
  }
  flush();
  return blocks;
}

async function outlinePages(doc) {
  const outline = (await doc.getOutline().catch(() => null)) || [];
  const resolve = async (items) => {
    const out = [];
    for (const it of items) {
      let page = null;
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        if (dest?.[0]) page = (typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0])) + 1;
      } catch {
        /* unresolved entry */
      }
      out.push({ title: (it.title || "").trim(), page, children: await resolve(it.items || []) });
    }
    return out;
  };
  return resolve(outline);
}

export async function pdfToEpub(doc, { title, author, language }, onProgress) {
  const pages = await readPages(doc, onProgress);
  dropFurniture(pages);
  const blocks = toBlocks(pages);
  if (blocks.reduce((n, b) => n + (b.text ?? b.lines.join("")).length, 0) < 200) {
    throw new Error("NO_TEXT");
  }

  // Section boundaries: top-level outline entries, otherwise every N pages.
  const outline = await outlinePages(doc);
  let starts = outline.map((o) => o.page).filter(Boolean);
  starts = [...new Set([1, ...starts])].sort((a, b) => a - b);
  if (starts.length < 2) {
    starts = [];
    for (let p = 1; p <= doc.numPages; p += PAGES_PER_SECTION) starts.push(p);
  }
  const sectionOfPage = (page) => {
    let idx = 0;
    starts.forEach((s, i) => page >= s && (idx = i));
    return idx;
  };

  const sections = starts.map(() => []);
  const seenPage = new Set();
  for (const b of blocks) {
    const sec = sections[sectionOfPage(b.page)];
    const anchor = seenPage.has(b.page) ? "" : ` id="page-${b.page}"`;
    seenPage.add(b.page);
    if (b.type === "v") sec.push(`<div class="v"${anchor}>${b.lines.map((t) => `<p>${esc(t)}</p>`).join("")}</div>`);
    else sec.push(b.type === "h" ? `<h2${anchor}>${esc(b.text)}</h2>` : `<p${anchor}>${esc(b.text)}</p>`);
  }

  const lang = language || "en";
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  const css = "p{margin:0;text-indent:1.4em}h2{margin:1.5em 0 .8em;text-indent:0}h2+p{text-indent:0}.v{margin:0 0 1em}.v p{text-align:left;hyphens:manual;-webkit-hyphens:manual;padding-left:1.5em;text-indent:-1.5em}";
  zip.file("OEBPS/style.css", css);
  // PDF page -> location in the EPUB, so switching views keeps the reader's place.
  const pageMap = {};
  let lastHref = "s1.xhtml";
  for (let p = 1; p <= doc.numPages; p++) {
    if (seenPage.has(p)) lastHref = `s${sectionOfPage(p) + 1}.xhtml#page-${p}`;
    pageMap[p] = lastHref;
  }
  zip.file("OEBPS/pagemap.json", JSON.stringify(pageMap));
  const manifest = [];
  const spine = [];
  sections.forEach((body, i) => {
    const name = `s${i + 1}.xhtml`;
    zip.file(
      `OEBPS/${name}`,
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}"><head><title>${esc(title)}</title><link rel="stylesheet" href="style.css"/></head><body>${body.join("\n") || "<p></p>"}</body></html>`
    );
    manifest.push(`<item id="s${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="s${i + 1}"/>`);
  });

  const navItem = (o) => {
    const target = o.page && seenPage.has(o.page) ? `s${sectionOfPage(o.page) + 1}.xhtml#page-${o.page}` : null;
    const kids = o.children.map(navItem).filter(Boolean).join("");
    if (!target && !kids) return "";
    const label = target ? `<a href="${target}">${esc(o.title || "—")}</a>` : `<span>${esc(o.title || "—")}</span>`;
    return `<li>${label}${kids ? `<ol>${kids}</ol>` : ""}</li>`;
  };
  let navList = outline.map(navItem).join("");
  if (!navList) navList = starts.map((p, i) => `<li><a href="s${i + 1}.xhtml">Сторінки ${p}–${starts[i + 1] - 1 || doc.numPages}</a></li>`).join("");
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>TOC</title></head><body><nav epub:type="toc"><ol>${navList}</ol></nav></body></html>`
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">pdf-reflow</dc:identifier><dc:title>${esc(title)}</dc:title>${author ? `<dc:creator>${esc(author)}</dc:creator>` : ""}<dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`
  );
  return zip.generateAsync({ type: "arraybuffer" });
}
