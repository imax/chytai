// Library: scans book folders and reads title/author/language from each file, with an on-disk cache.
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { langFromText, epubSample } = require("../server/language");

const BOOK_EXTS = ["epub", "pdf", "fb2", "mobi", "azw", "azw3", "azw4", "prc", "kfx", "lit", "pdb"];
const MAX_DEPTH = 4;
const META_VERSION = 2; // bump to re-read every book's metadata (2: language from the text)

const ICLOUD = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs");

// iCloud Drive/Books is the library; the old Downloads dump is only a fallback.
function defaultFolders() {
  const found = ["Books", "Backups/Downloads"].map((d) => path.join(ICLOUD, d)).find((d) => fs.existsSync(d));
  return found ? [found] : [];
}

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < MAX_DEPTH) walk(full, depth + 1, out);
    else if (e.isFile() && BOOK_EXTS.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(full);
  }
}

// Old downloads often have names that are URL-encoded or cp1251/UTF-8 bytes read as Latin-1 ("Ëåì_05").
function cleanName(file) {
  let name = path.basename(file, path.extname(file)).normalize("NFC");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not URL-encoded */
  }
  if (/[À-ÿ]/.test(name) && !/[Ѐ-ӿ]/.test(name) && /^[\u0000-ÿ]*$/.test(name)) {
    const bytes = Buffer.from(name, "latin1");
    for (const enc of ["utf-8", "windows-1251"]) {
      try {
        const fixed = new TextDecoder(enc, { fatal: true }).decode(bytes);
        if (/[Ѐ-ӿ]/.test(fixed)) {
          name = fixed;
          break;
        }
      } catch {
        /* try the next encoding */
      }
    }
  }
  return name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

const decodeXml = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function tagValues(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => decodeXml(m[1])).filter(Boolean);
}

async function epubMeta(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath && (await zip.file(opfPath)?.async("string"));
  if (!opf) return {};
  const year = tagValues(opf, "date").map((d) => d.match(/\d{4}/)?.[0]).find(Boolean);
  const metaLang = (tagValues(opf, "language")[0] || "").toLowerCase().split("-")[0];
  let lang = metaLang;
  try {
    lang = langFromText((await epubSample(zip)).text, metaLang) || metaLang;
  } catch {
    /* text unreadable: keep the metadata */
  }
  return {
    title: tagValues(opf, "title")[0],
    authors: [...new Set(tagValues(opf, "creator"))],
    lang,
    year,
  };
}

function fb2Meta(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let head = buf.subarray(0, n).toString("latin1");
  const enc = head.match(/encoding="([^"]+)"/i)?.[1]?.toLowerCase() || "utf-8";
  head = new TextDecoder(enc === "windows-1251" || enc === "cp1251" ? "windows-1251" : "utf-8").decode(buf.subarray(0, n));
  const info = head.match(/<title-info>([\s\S]*?)<\/title-info>/)?.[1] || "";
  const authors = [...info.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) =>
    ["first-name", "middle-name", "last-name"].map((t) => tagValues(m[1], t)[0]).filter(Boolean).join(" "),
  );
  return { title: tagValues(info, "book-title")[0], authors: authors.filter(Boolean), lang: tagValues(info, "lang")[0], year: tagValues(info, "date")[0]?.match(/\d{4}/)?.[0] };
}

// macOS keeps iCloud files that are not downloaded as "dataless": they have a size but no blocks.
// Reading one would download it, so for those we only use the file name until it is downloaded.
const isCloudOnly = (st) => process.platform === "darwin" && st.size > 0 && st.blocks === 0;

// Normalises spacing only ("Станислав  Лем", "АртемБородатюк"); name order is left as the file has it.
const cleanAuthor = (a) => a.replace(/([а-яіїєґ])([А-ЯІЇЄҐ])/g, "$1 $2").replace(/\s+/g, " ").trim();

async function readMeta(file, st) {
  const ext = path.extname(file).slice(1).toLowerCase();
  let meta = {};
  if (!isCloudOnly(st)) {
    try {
      if (ext === "epub") meta = await epubMeta(file);
      else if (ext === "fb2") meta = fb2Meta(file);
    } catch {
      /* unreadable file: fall back to the name */
    }
  }
  let title = meta.title && meta.title !== "Unknown" ? meta.title : cleanName(file);
  let authors = meta.authors || [];
  // Files without metadata (PDF, MOBI) named "Автор - Назва" give both.
  const named = !meta.title && title.match(/^(.+?) - (.+)$/);
  if (named) [, authors, title] = [null, [named[1]], named[2]];
  return { title, authors: authors.map(cleanAuthor).filter(Boolean), lang: (meta.lang || "").toLowerCase().split("-")[0], year: meta.year || "", fromName: !meta.title };
}

async function scan(folders, cacheFile) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    /* first scan */
  }
  const files = [];
  for (const folder of folders) walk(folder, 0, files);
  const nextCache = {};
  const books = [];
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const cloud = isCloudOnly(st);
    const key = `${META_VERSION}:${st.size}:${Math.round(st.mtimeMs)}:${cloud ? "c" : "l"}`;
    const meta = cache[file]?.key === key ? cache[file].meta : await readMeta(file, st);
    nextCache[file] = { key, meta };
    books.push({ path: file, ext: path.extname(file).slice(1).toLowerCase(), size: st.size, mtime: Math.round(st.mtimeMs), cloud, ...meta });
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(nextCache));
  return dedupe(books);
}

// The same book downloaded twice ("x.epub", "x 2.epub") shows once.
function dedupe(books) {
  const seen = new Map();
  for (const b of books.sort((a, b) => a.path.length - b.path.length)) {
    const k = `${b.title.toLowerCase()}|${b.authors.join(";").toLowerCase()}|${b.size}`;
    if (!seen.has(k)) seen.set(k, b);
  }
  return [...seen.values()];
}

module.exports = { scan, defaultFolders };
