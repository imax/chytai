// Keeps pornography out of the shared library: before an upload is kept, a cheap model reads the
// book's metadata, short excerpts from across the text and the cover, and says whether it is porn.
// Ordinary literature with adult themes or some sex scenes passes; erotica and porn do not.
const Anthropic = require("@anthropic-ai/sdk");
const JSZip = require("jszip");
const { stripTags } = require("./language");

const MODEL = "claude-haiku-5-5";
const EXCERPTS = 8; // excerpts spread through the book
const EXCERPT_CHARS = 1200;
const COVER_MAX = 3_500_000; // bigger covers are left out rather than resized
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

const PROMPT = `You check books uploaded to a private family e-book library. The family includes a 9-year-old child, and the library is shared with invited friends. Your only job is to keep pornography out.

BLOCK the book if it is pornography or erotica: a book whose main purpose is sexual arousal, such as erotic novels and story collections, explicit sex scenes as the bulk of the text, porn magazines or photo books, hentai or explicit comics, or a sexually explicit or nude cover. Always BLOCK any sexual content involving minors.

ALLOW everything else, including:
- literary and genre fiction with adult themes, violence, or some sex scenes (e.g. Ulysses, Lolita, A Song of Ice and Fire, Murakami, mainstream romance where the story carries the book);
- classical art, anatomy, medicine, sex education, psychology and history of sexuality;
- books you cannot judge from the excerpts.

When in doubt, ALLOW. You see only the metadata, a few excerpts and maybe the cover, so judge the book as a whole, not one passage.

Answer with one word on the first line, ALLOW or BLOCK, then one short line in English saying why.`;

async function epubParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = (opfPath && (await zip.file(opfPath)?.async("string"))) || "";
  const base = opfPath?.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const tag = (name) => [...opf.matchAll(new RegExp(`<dc:${name}[^>]*>([\\s\\S]*?)</dc:${name}>`, "gi"))].map((m) => stripTags(m[1]).trim()).filter(Boolean);
  const meta = { title: tag("title")[0], authors: tag("creator"), subjects: tag("subject"), description: tag("description")[0]?.slice(0, 1500) };

  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => {
    const attr = (name) => m[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "";
    return { id: attr("id"), href: decodeURIComponent(attr("href")), type: attr("media-type"), props: attr("properties") };
  });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => byId[m[1]]?.href).filter(Boolean);
  const chapters = [];
  for (const href of spine) {
    const file = zip.file(base + href) || zip.file(href);
    const text = file ? stripTags(await file.async("string")).replace(/\s+/g, " ").trim() : "";
    if (text.length > 200) chapters.push(text);
  }

  const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/)?.[1] || opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/)?.[1];
  const coverItem =
    items.find((i) => i.props.split(/\s+/).includes("cover-image")) ||
    items.find((i) => i.id === coverId && i.type.startsWith("image/")) ||
    items.find((i) => /cover/i.test(i.id + i.href) && i.type.startsWith("image/"));
  let cover = null;
  if (coverItem) {
    const data = await (zip.file(base + coverItem.href) || zip.file(coverItem.href))?.async("nodebuffer");
    const type = IMAGE_TYPES[coverItem.href.split(".").pop().toLowerCase()];
    if (data && type && data.length <= COVER_MAX) cover = { type, data };
  }
  return { meta, chapters, cover };
}

async function pdfParts(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, verbosity: 0 }).promise;
  const info = (await doc.getMetadata().catch(() => null))?.info || {};
  const pages = new Set([1, 2, 3]);
  for (let k = 1; k <= EXCERPTS; k++) pages.add(Math.ceil((doc.numPages * k) / (EXCERPTS + 1)));
  const chapters = [];
  for (const p of [...pages].filter((p) => p >= 1 && p <= doc.numPages).sort((a, b) => a - b)) {
    const content = await (await doc.getPage(p)).getTextContent();
    const text = content.items.map((i) => i.str || "").join(" ").replace(/\s+/g, " ").trim();
    if (text.length > 100) chapters.push(text);
  }
  doc.cleanup?.();
  return { meta: { title: info.Title, authors: info.Author ? [info.Author] : [], subjects: info.Keywords ? [info.Keywords] : [] }, chapters, cover: null };
}

// Excerpts from evenly spaced chapters, each from the middle of its chapter (openings are often epigraphs).
function excerpts(chapters) {
  const picked = [];
  const n = Math.min(EXCERPTS, chapters.length);
  for (let k = 0; k < n; k++) {
    const text = chapters[Math.floor((k * chapters.length) / n)];
    const start = Math.max(0, Math.floor(text.length / 2 - EXCERPT_CHARS / 2));
    picked.push(text.slice(start, start + EXCERPT_CHARS));
  }
  return picked;
}

function userMessage(name, { meta, chapters, cover }) {
  const lines = [`File name: ${name}`];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.authors?.length) lines.push(`Author: ${meta.authors.join(", ")}`);
  if (meta.subjects?.length) lines.push(`Subjects: ${meta.subjects.join("; ")}`);
  if (meta.description) lines.push(`Description: ${meta.description}`);
  const parts = excerpts(chapters);
  lines.push(parts.length ? parts.map((t, i) => `<excerpt n="${i + 1}">\n${t}\n</excerpt>`).join("\n") : "(no readable text)");
  const content = [];
  if (cover) {
    content.push({ type: "text", text: "Cover:" });
    content.push({ type: "image", source: { type: "base64", media_type: cover.type, data: cover.data.toString("base64") } });
  }
  content.push({ type: "text", text: lines.join("\n") });
  return { role: "user", content };
}

// { blocked, reason, usage }. Anything that goes wrong (no key, no network, an unreadable file)
// lets the book in: a missed check is better than a family member who cannot add a book.
async function checkUpload(name, buffer, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) return { blocked: false, reason: "no API key" };
  try {
    const parts = /\.pdf$/i.test(name) ? await pdfParts(buffer) : await epubParts(buffer);
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({ model: MODEL, max_tokens: 100, system: PROMPT, messages: [userMessage(name, parts)] });
    // A refusal here means the model would not even look at the excerpts.
    if (message.stop_reason === "refusal") return { blocked: true, reason: "model refused", usage: message.usage };
    const text = message.content.map((b) => b.text || "").join("").trim();
    return { blocked: /^\W*BLOCK/i.test(text), reason: text.split("\n").slice(1).join(" ").trim(), usage: message.usage };
  } catch (err) {
    console.warn("content check", name, err.message);
    return { blocked: false, reason: `check failed: ${err.message}` };
  }
}

module.exports = { checkUpload, userMessage, excerpts, epubParts, pdfParts, PROMPT, MODEL };
