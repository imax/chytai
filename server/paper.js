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

async function ask(apiKey, model, prompt, image, mediaType) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } }, { type: "text", text: prompt }] }],
  });
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

async function readPage(apiKey, image, mediaType) {
  const r = await ask(apiKey, PAGE_MODEL, PAGE_PROMPT, image, mediaType);
  let text = r.text;
  let page = null;
  const m = text.match(/^PAGE:\s*(\d{1,5})\s*\n?/);
  if (m) {
    page = Number(m[1]);
    text = text.slice(m[0].length);
  }
  return { text: text.trim().slice(0, 20000), page, usage: r.usage, model: r.model };
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

module.exports = { NAME, readCover, readPage, listEntry, COVER_MODEL, PAGE_MODEL };
