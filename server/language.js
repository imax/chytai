// Tells whether an uploaded book is in Russian, from its text (and, failing that, its metadata).
// Chytai does not take Russian-language books, so the upload is refused before the file is kept.
const JSZip = require("jszip");

const SAMPLE_CHARS = 40000; // enough text to decide, little enough to stay quick
const MIN_LETTERS = 300; // below this the text says too little; the metadata decides

// Letters that exist in one alphabet only. Old Ukrainian orthographies used ё and ъ too, so the
// Ukrainian side wins unless the Russian-only letters clearly dominate.
const RU_ONLY = /[ыэъё]/gi;
const UK_ONLY = /[іїєґ]/gi;
const CYRILLIC = /[а-яёіїєґ]/gi;

function verdictFromText(text, metaLang) {
  const letters = (text.match(CYRILLIC) || []).length;
  if (letters < MIN_LETTERS) return (metaLang || "").toLowerCase().startsWith("ru");
  const ru = (text.match(RU_ONLY) || []).length;
  const uk = (text.match(UK_ONLY) || []).length;
  return ru > 10 && ru > uk * 3;
}

// Cyrillic text says which language it is better than a book's metadata, which is sometimes plain
// wrong (a Ukrainian book tagged "ar"). Returns "uk" or "ru" for clearly Cyrillic text, else "".
const LATIN = /[a-z]/gi;
const OTHER_CYRILLIC = ["be", "bg", "sr", "mk", "kk", "ky", "tg", "mn", "ba", "tt", "cv", "os"];
function langFromText(text, metaLang = "") {
  const cyr = (text.match(CYRILLIC) || []).length;
  if (cyr < MIN_LETTERS || cyr < (text.match(LATIN) || []).length * 2) return "";
  if (OTHER_CYRILLIC.includes(metaLang)) return metaLang;
  return verdictFromText(text, metaLang) ? "ru" : "uk";
}

const stripTags = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");

async function epubSample(buffer) {
  const zip = buffer instanceof JSZip ? buffer : await JSZip.loadAsync(buffer);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath ? await zip.file(opfPath)?.async("string") : "";
  const metaLang = opf?.match(/<(?:dc:)?language[^>]*>([^<]*)</i)?.[1]?.trim() || "";
  const base = opfPath?.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const items = {};
  for (const m of (opf || "").matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) items[id] = decodeURIComponent(href);
  }
  const spine = [...(opf || "").matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => items[m[1]]).filter(Boolean);
  let text = "";
  for (const href of spine) {
    if (text.length >= SAMPLE_CHARS) break;
    const file = zip.file(base + href) || zip.file(href);
    if (file) text += stripTags(await file.async("string")) + " ";
  }
  return { text: text.slice(0, SAMPLE_CHARS * 2), metaLang };
}

async function pdfSample(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, verbosity: 0 }).promise;
  let text = "";
  for (let p = 1; p <= Math.min(doc.numPages, 8) && text.length < SAMPLE_CHARS; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    text += content.items.map((i) => i.str || "").join(" ") + " ";
  }
  doc.cleanup?.();
  return { text, metaLang: "" };
}

// true when the book reads as Russian; false when it does not or cannot be read at all.
async function isRussian(name, buffer) {
  try {
    const { text, metaLang } = /\.pdf$/i.test(name) ? await pdfSample(buffer) : await epubSample(buffer);
    return verdictFromText(text, metaLang);
  } catch {
    return false;
  }
}

module.exports = { isRussian, verdictFromText, langFromText, epubSample, stripTags };
