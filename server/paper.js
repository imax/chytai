// Paper books (Max, 2026-11-02): a book read on paper sits among the reader's books without a file, so its
// explanations, questions and notes are in one place and the AI knows the book and the page. Two photo helpers:
// a cover becomes a title and author to find in the catalog; a page becomes text to select and explain.
const Anthropic = require("@anthropic-ai/sdk");

const NAME = /^paper-[a-f0-9]{10}\.paper$/;
const COVER_MODEL = "claude-haiku-5-5";
const PAGE_MODEL = "claude-sonnet-5-5";

const COVER_PROMPT = `This is a photo of a book cover (or a spine or title page). Read the book's title and author as printed.
Answer with JSON only, no other text: {"title": "...", "author": "..."}. Keep the language and spelling of the cover. Leave out series names, slogans and publisher blurbs. If there is no book in the photo, answer {"title": "", "author": ""}.`;

const PAGE_PROMPT = `This is a photo of a page (or two facing pages) of a printed book. Transcribe the book's text exactly as printed, in reading order, keeping its language and spelling.
- Join words hyphenated across line breaks; keep paragraphs, separated by a blank line.
- Leave out running heads, footers and anything outside the page (fingers, the table).
- If a page number is printed, put it on the first line as "PAGE: <number>" (the first page's, for two pages); otherwise leave that line out.
Answer with the text only, no comments.`;

// The text the reader marked on the photo (Max, 2026-11-04: circle it and it becomes a note).
const MARKED_PROMPT = `This is a photo of a page of a printed book. The reader marked part of it with red strokes: circled, underlined, bracketed or crossed along the margin.
Transcribe exactly as printed only the text the marks point to, in reading order, keeping its language and spelling. A circle takes what is inside it; an underline the underlined words (the whole sentence if most of it is underlined); a mark in the margin the lines beside it.
- Join words hyphenated across line breaks; keep paragraphs, separated by a blank line.
- If a page number is printed, put it on the first line as "PAGE: <number>"; otherwise leave that line out.
Answer with the text only, no comments. If nothing readable is marked, answer with nothing.`;

// Only the page number (2026-11-04: transcribing the whole page for it was slow and its number got lost).
const PAGENUM_PROMPT = `This is a photo of a printed book, one page or two facing pages, maybe at an angle. Find the printed page number (in a corner, at the top or bottom of the page; for two pages, the right-hand page's). Answer with the number only, digits, nothing else. If no page number is visible, answer "none".`;

async function ask(apiKey, model, prompt, image, mediaType, maxTokens = 4000) {
  const client = new Anthropic({ apiKey });
  const content = image ? [{ type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } }, { type: "text", text: prompt }] : prompt;
  const msg = await client.messages.create({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  return { text: msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), usage: msg.usage, model: msg.model };
}

async function readCover(apiKey, image, mediaType) {
  const r = await ask(apiKey, COVER_MODEL, COVER_PROMPT, image, mediaType);
  const json = r.text.match(/\{[\s\S]*\}/);
  let out = { title: "", author: "" };
  try {
    const j = JSON.parse(json?.[0] || "{}");
    out = { title: String(j.title || "").trim().slice(0, 300), author: String(j.author || "").trim().slice(0, 300) };
  } catch {}
  return { ...out, usage: r.usage, model: r.model };
}

async function readPage(apiKey, image, mediaType, marked = false) {
  const r = await ask(apiKey, PAGE_MODEL, marked ? MARKED_PROMPT : PAGE_PROMPT, image, mediaType);
  let text = r.text;
  let page = null;
  const m = text.match(/^\s*PAGE:\s*(\d{1,5})[^\n]*\n?/);
  if (m) {
    page = Number(m[1]);
    text = text.slice(m[0].length);
  }
  return { text: text.trim().slice(0, 20000), page, usage: r.usage, model: r.model };
}

async function readPageNumber(apiKey, image, mediaType) {
  const r = await ask(apiKey, PAGE_MODEL, PAGENUM_PROMPT, image, mediaType, 20);
  const n = Number(r.text.match(/\d{1,5}/)?.[0] || 0);
  return { page: n > 0 ? n : null, usage: r.usage, model: r.model };
}

// Questions to ask (v3, Max: «можна придумувати питання, знаючи назву книжки… або follow-up до попереднього»):
// three short ones in Ukrainian, about where the reader is, or following on from the last question.
async function suggest(apiKey, { title, author, page, last }) {
  const prompt = `A reader is reading a printed copy of «${title}»${author ? ` by ${author}` : ""}${page ? `, now around page ${page}` : ""}.
${last ? `Their last question about it was: «${last.q}»\nThe answer began: «${last.a.slice(0, 600)}»\nSuggest one short follow-up question they might want to ask next.` : "Suggest one short question they might want to ask about the book at this point: context, characters, ideas, words or history a reader often wonders about."}
The question in Ukrainian, at most 9 words, natural and specific to this book, no spoilers beyond where they are. Answer with JSON only: ["…"]. If you don't know the book, make it general but useful.`;
  const r = await ask(apiKey, COVER_MODEL, prompt);
  let list = [];
  try {
    list = JSON.parse(r.text.match(/\[[\s\S]*\]/)?.[0] || "[]");
  } catch {}
  return { questions: list.filter((q) => typeof q === "string" && q.trim()).slice(0, 1).map((q) => q.trim().slice(0, 120)), usage: r.usage, model: r.model };
}

// Dictated text, tidied (Max 2026-11-03: «Згадую Роман зачарована гора Томаса» should read «Згадую роман
// «Зачарована гора» Томаса…»): punctuation, capitals, book titles in «», misheard words, nothing added.
async function tidy(apiKey, { title, author, text, ebook = false }) {
  const prompt = `A reader dictated this by voice while reading ${ebook ? "" : "a printed copy of "}«${title}»${author ? ` by ${author}` : ""}. Speech recognition gave raw words without punctuation, sometimes with misheard words:
<dictation>${text}</dictation>
Rewrite it as the reader meant it: add punctuation and sentence capitals, put titles of books and works in «» with capitals as usual in Ukrainian (a word like «роман» before a title is not a name), fix obviously misheard words and names. Keep the reader's words, order and language; don't add, explain or shorten anything. Answer with the text only.`;
  const r = await ask(apiKey, COVER_MODEL, prompt);
  let out = r.text.replace(/^<dictation>|<\/dictation>$/g, "").trim();
  if (!out || out.length > text.length * 1.6 + 20) out = text;
  return { text: out, usage: r.usage, model: r.model };
}

// A paper book's kept talk without the photo in it: the picture is several hundred KB and is not kept.
function stripImages(messages) {
  if (!Array.isArray(messages)) return null;
  return messages.map((m) => (Array.isArray(m?.content) ? { ...m, content: m.content.map((b) => (b?.type === "image" ? { type: "text", text: "[Фото сторінки з позначками читача]" } : b)) } : m));
}

// What the library shows for a paper book of this reader.
function listEntry(name, p, u) {
  const aside = !!u.setAside?.[name];
  const pct = p.pages && p.page ? Math.max(0, Math.min(100, Math.round((p.page / p.pages) * 100))) : null;
  return {
    path: name, title: p.title, authors: p.author ? [p.author] : [], ext: "paper", paper: true, cloud: false,
    coverSrc: p.cover || "", href: p.href || "", pages: p.pages || 0, page: p.page || 0, chapter: aside ? "" : p.chapter || "",
    openedAt: aside ? 0 : u.opened?.[name] || 0, aside, finished: !!u.finished?.[name],
    started: !aside && !!p.page, pct: aside ? null : pct, part: 0, parts: 0,
    addedAt: p.addedAt || 0, addedBy: "", coverAt: 0, seen: true, mtime: 0, language: p.language || "uk",
  };
}

module.exports = { NAME, readCover, readPage, readPageNumber, suggest, tidy, stripImages, listEntry, COVER_MODEL, PAGE_MODEL };
