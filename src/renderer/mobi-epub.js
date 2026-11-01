/* global JSZip */
// MOBI and AZW3 (Kindle) books become EPUB in the browser before they are uploaded (Max, 2026-11-01), so the
// reader itself only ever opens EPUB. foliate-js reads the Kindle file; each section it gives back is an HTML
// page whose pictures and styles are blob: addresses, and those go into the EPUB as files of their own.
import { MOBI } from "../../node_modules/foliate-js/mobi.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp", "text/css": "css", "font/ttf": "ttf", "font/otf": "otf", "application/vnd.ms-opentype": "otf", "font/woff": "woff" };
// Kindle records carry no reliable type; pictures are told apart by their first bytes.
const sniff = (b) =>
  b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg"
  : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
  : b[0] === 0x47 && b[1] === 0x49 ? "image/gif"
  : b[8] === 0x57 && b[9] === 0x45 ? "image/webp"
  : "";
const XHTML = "http://www.w3.org/1999/xhtml";

const text = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean).join(", ") : typeof v === "object" && v ? text(v.name ?? Object.values(v)[0]) : String(v ?? "").trim());

export async function mobiToEpub(file) {
  // Fonts inside Kindle files are zlib-packed; without them the book's own text font is simply not used.
  const book = await new MOBI({ unzlib: async () => { throw new Error("fonts are not kept"); } }).open(file);
  const meta = book.metadata || {};
  const title = text(meta.title) || file.name.replace(/\.[^.]+$/, "");
  const author = text(meta.author);
  const lang = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(text(meta.language)) ? text(meta.language) : "uk";

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const manifest = [];
  const files = new Map(); // blob: address -> file name in the EPUB

  // A blob: address in the book becomes a file next to the pages; a stylesheet's own addresses too.
  async function keep(url) {
    if (files.has(url)) return files.get(url);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return null;
    const blob = await res.blob();
    const type = sniff(new Uint8Array(await blob.slice(0, 12).arrayBuffer())) || (blob.type || "").split(";")[0];
    const name = `r${files.size + 1}.${EXT[type] || "bin"}`;
    files.set(url, name);
    if (type === "text/css") zip.file(`OEBPS/${name}`, await rewrite(await blob.text()));
    else zip.file(`OEBPS/${name}`, await blob.arrayBuffer());
    manifest.push(`<item id="${name.replace(".", "-")}" href="${name}" media-type="${type || "application/octet-stream"}"/>`);
    return name;
  }
  async function rewrite(str) {
    for (const url of new Set(str.match(/blob:[^"')\s]+/g) || [])) {
      const name = await keep(url);
      str = str.split(url).join(name || "");
    }
    return str;
  }

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const pages = [];
  for (const [i, section] of book.sections.entries()) {
    if (section.linear === "no" && i > 0) continue;
    const url = await section.load();
    const res = await fetch(url);
    const type = (res.headers.get("Content-Type") || "").includes("xhtml") ? "application/xhtml+xml" : "text/html";
    let doc = parser.parseFromString(await res.text(), type);
    if (doc.querySelector("parsererror")) doc = parser.parseFromString(await (await fetch(url)).text(), "text/html");
    // Kindle-only tags (mbp:pagebreak and the like) are not XHTML; scripts never go into a book.
    for (const el of [...doc.querySelectorAll("*")]) if (el.tagName.includes(":") || /^(script|iframe|object|embed|guide)$/i.test(el.tagName)) el.remove();
    for (const el of doc.querySelectorAll("[recindex]")) el.removeAttribute("recindex");
    const head = [...doc.querySelectorAll("head style, head link[rel~=stylesheet]")].map((n) => serializer.serializeToString(n)).join("");
    const body = [...(doc.body?.childNodes || [])].map((n) => serializer.serializeToString(n)).join("");
    const name = `s${pages.length + 1}.xhtml`;
    pages.push({ name, index: i, doc });
    let xhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${XHTML}" lang="${lang}" xml:lang="${lang}"><head><title>${esc(title)}</title>${head}</head><body>${body || "<p></p>"}</body></html>`;
    xhtml = (await rewrite(xhtml)).replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"(?=[^>]*>)/g, (m, off) => (off < 80 ? m : ""));
    zip.file(`OEBPS/${name}`, xhtml);
    manifest.push(`<item id="${name.replace(".", "-")}" href="${name}" media-type="application/xhtml+xml"/>`);
  }
  if (!pages.length) throw new Error("У файлі не знайшлося тексту.");

  // Contents: each entry goes to the page it is on (and to its place there when the page has an id for it).
  const pageOf = (href) => {
    try {
      const { index } = book.resolveHref(href);
      return pages.find((p) => p.index === index)?.name || null;
    } catch {
      return null;
    }
  };
  const navItem = (o) => {
    const target = o.href && pageOf(o.href);
    const kids = (o.subitems || []).map(navItem).join("");
    if (!target && !kids) return "";
    const label = target ? `<a href="${target}">${esc(o.label || "—")}</a>` : `<span>${esc(o.label || "—")}</span>`;
    return `<li>${label}${kids ? `<ol>${kids}</ol>` : ""}</li>`;
  };
  let nav = (book.toc || []).map(navItem).join("");
  // No contents in the file: each page by its first heading, or «Частина N».
  if (!nav) nav = pages.map((p, i) => `<li><a href="${p.name}">${esc(p.doc.querySelector("h1, h2, h3")?.textContent.trim().slice(0, 120) || `Частина ${i + 1}`)}</a></li>`).join("");
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Зміст</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`);

  let coverMeta = "";
  try {
    const cover = await book.getCover?.();
    if (cover) {
      const type = cover.type || "image/jpeg";
      const name = `cover.${EXT[type] || "jpg"}`;
      zip.file(`OEBPS/${name}`, await cover.arrayBuffer());
      manifest.push(`<item id="cover-image" href="${name}" media-type="${type}" properties="cover-image"/>`);
      coverMeta = `<meta name="cover" content="cover-image"/>`;
    }
  } catch {
    /* no cover */
  }

  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">mobi-${Date.now()}</dc:identifier><dc:title>${esc(title)}</dc:title>${author ? `<dc:creator>${esc(author)}</dc:creator>` : ""}<dc:language>${esc(lang)}</dc:language>${coverMeta}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest><spine>${pages.map((p) => `<itemref idref="${p.name.replace(".", "-")}"/>`).join("")}</spine></package>`);
  return { data: await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" }), title };
}
