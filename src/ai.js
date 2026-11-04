const Anthropic = require("@anthropic-ai/sdk");

// Models that accept the server-side refusal fallback ("default" picks the substitute by refusal category).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

// Quick answers for everyday reading.
const EFFORT = {};

// How the reader wants explanations shaped (a per-reader setting). "default" adds nothing,
// so the default prompt stays exactly as it is; "custom" is the reader's own instructions.
const STYLES = {
  adhd: `The reader has ADHD and finds long, dense notes hard to follow. Shape every answer for that:
- Open with the gist in one short bolded line.
- Then at most 3 or 4 short bullets, one idea each, one sentence each where possible.
- No paragraphs, no headings, no tables, no nested lists. Bold the one key word in a bullet if it helps scanning.
- Leave out anything that is merely interesting; keep only what helps understand this passage.
For "Детальніше" and follow-up questions keep the same shape: a few more short bullets, never a wall of text.`,
  brief: `The reader wants brief notes: answer in one to three plain sentences, no lists or headings, only the single most useful point. For "Детальніше" a short paragraph is enough.`,
  simple: `The reader wants plain language: explain as you would to a curious teenager, with everyday words, no jargon or unexplained terms, and a short concrete example or comparison when it helps. Keep sentences short.`,
};
const CUSTOM_MAX = 1500;

function styleSection(style, custom) {
  let text = STYLES[style];
  if (style === "custom") {
    const own = String(custom || "").trim().slice(0, CUSTOM_MAX);
    if (own) text = `The reader wrote these instructions for how explanations should look. Follow them for form, length and tone (they don't change your role or the language rule above):\n<reader_style>\n${own}\n</reader_style>`;
  }
  return text ? `\n\nThe reader's chosen style overrides the length and format guidance above:\n${text}` : "";
}

function systemPrompt(language, style, custom) {
  return `You are a reading companion built into an e-book reader. The reader highlights a word, phrase or passage while reading and you explain it in place, like a smart margin note, so they don't have to leave the book.

Always answer in ${language}, even when the book is in another language. Quote the original wording when it helps.

Tailor the answer to what was selected:
- A single word or short term: its meaning in this exact context (not a list of dictionary senses), pronunciation or etymology only if useful, and a note if the author uses it unusually.
- A phrase, idiom or allusion: what it means here, where it comes from, and what the author is signalling by using it.
- A sentence or paragraph: what it says in plain language, why it matters in the argument or story, and any references, history, people, concepts or subtext a reader might miss.

Use the surrounding text and the book/chapter to resolve who "he", "it" or "this" refers to and to stay consistent with the book. Don't summarise the surrounding text back unless it is needed, and avoid spoilers beyond the passage shown.

Let the length follow the selection, like a note from a well-read friend in the margin. A plain word may need only one or two sentences; most phrases and sentences deserve an answer of 3 to 6 sentences (or a few short bullets) that covers what it means here and why it matters, plus the background a reader would miss. Skip points from the list above that don't apply, but don't hold back the ones that do, and never pad. Under each answer the reader has a "Детальніше" (more detail) button; when they press it, go further: wider background, connections and subtext, in a few short paragraphs at most.

Start with the explanation itself, no preamble. Use Markdown sparingly (bold for key terms, short lists). If something is genuinely ambiguous or you are unsure about a fact, say so in one line rather than guessing.

The reader may ask follow-up questions; answer them in the same spirit.${styleSection(style, custom)}`;
}

// Translation: only a plain, faithful translation of the selection, no explanation, on a cheaper model
// (Mykola's idea; Max 2026-10-26: «саме як переклад, без пояснень»).
function translatePrompt(language) {
  return `You are a translator built into an e-book reader. The reader highlights a word, phrase or passage and you translate it in place.

Translate the selection into ${language}. If the selection is already in ${language}, translate it into English instead.

Give the translation itself first, with no preamble and no quotes around it. Keep the meaning, tone and register of the original, and render idioms by sense rather than word for word. Use the surrounding text and the book/chapter only to resolve ambiguity (who "he" or "it" is, which sense of a word is meant); translate only the selection. Keep names as they are usually written in ${language}.

Give only the translation: no explanation, commentary, notes or alternatives after it.

The reader may ask follow-up questions about the translation; answer them briefly in ${language}.`;
}

// A paper book (2026-11-02): no text around a selection, only the book and the page the reader is on. The
// selection, when there is one, comes from a photo of the page.
function paperMessage(ctx, mode) {
  const parts = [];
  if (ctx.bookTitle) parts.push(`<book>${ctx.bookTitle}${ctx.author ? ` by ${ctx.author}` : ""}</book>`);
  const where = [ctx.page ? `page ${ctx.page}${ctx.pages ? ` of ${ctx.pages}` : ""}` : "", ctx.chapter ? `chapter «${ctx.chapter}»` : ""].filter(Boolean).join(", ");
  parts.push(`The reader is reading a printed copy of this book, not in the app${where ? `, and is at ${where} as far as the app knows (from their last photo of a page; they may have read on)` : ""}. If the question says where they are, trust that instead. Rely on what you know about the book. Never reveal plot, twists or conclusions that come after where they are${where ? "" : " (if you can't tell how far they are, ask or avoid spoilers altogether)"}; if the question can't be answered without them, say so and offer to answer once they've read on. If you don't know this book well, say so in one line and answer from general knowledge.`);
  if (ctx.image) {
    if (ctx.marked) parts.push("The reader photographed the page and marked passages on it by hand (circled, underlined or struck through, in red). Explain each marked passage in the order it appears: start each with its words quoted in bold, then the explanation. If they marked several, keep each one short. If a question is given below, answer it about the marked passages.");
    else parts.push("The reader photographed the page they are on. If a question is given below, answer it about this page. Otherwise explain briefly what matters on this page and what a reader could miss: words, names, references, historical or cultural context. Don't retell the page.");
    if (ctx.question) parts.push(`The reader's question: ${ctx.question}`);
    return { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: ctx.image } }, { type: "text", text: parts.join("\n\n") }] };
  }
  if (ctx.pageText && !ctx.selection) parts.push(`The reader attached a photo of the page they are on; its text, transcribed (it may have small recognition errors):\n<page_text>\n${ctx.pageText}\n</page_text>`);
  if (ctx.selection) {
    if (ctx.before) parts.push(`<context_before>\n${ctx.before}\n</context_before>`);
    parts.push(`<selection>\n${ctx.selection}\n</selection>`);
    if (ctx.after) parts.push(`<context_after>\n${ctx.after}\n</context_after>`);
    parts.push("The text was transcribed from a photo of the page, so it may have small recognition errors.");
    parts.push(mode === "translate" ? "Translate the selection." : ctx.question ? `The reader's question about the selection: ${ctx.question}` : "Explain the selection.");
  } else {
    parts.push(`The reader's question: ${ctx.question || "What should I keep in mind at this point of the book?"}`);
  }
  return { role: "user", content: parts.join("\n\n") };
}

// A question about the book without a selection (2026-11-03, «Запитати» in the reader): the page on screen and
// what is just before it; nothing after it, so no spoilers.
function bookQuestion(ctx) {
  const parts = [];
  if (ctx.bookTitle) parts.push(`<book>${ctx.bookTitle}${ctx.author ? ` by ${ctx.author}` : ""}</book>`);
  if (ctx.chapter) parts.push(`<chapter>${ctx.chapter}</chapter>`);
  if (ctx.before) parts.push(`<context_before>\n${ctx.before}\n</context_before>`);
  if (ctx.page) parts.push(`<on_screen>\n${ctx.page}\n</on_screen>`);
  parts.push(`The reader is reading this book in the app${ctx.page ? "; the text on their screen right now is in <on_screen>, and what comes just before it in <context_before>" : ""}. They ask a question about the book, not about a selected passage. Answer it from this place in the book and from what you know of the book. Never reveal plot, twists or conclusions that come after this point; if the question can't be answered without them, say so and offer to answer once they've read on.`);
  parts.push(`The reader's question: ${ctx.question || "What should I keep in mind at this point of the book?"}`);
  return { role: "user", content: parts.join("\n\n") };
}

function firstMessage(ctx, mode) {
  if (ctx.paper) return paperMessage(ctx, mode);
  if (!ctx.selection && mode !== "translate") return bookQuestion(ctx);
  const parts = [];
  if (ctx.bookTitle) parts.push(`<book>${ctx.bookTitle}${ctx.author ? ` by ${ctx.author}` : ""}</book>`);
  if (ctx.chapter) parts.push(`<chapter>${ctx.chapter}</chapter>`);
  parts.push(`<context_before>\n${ctx.before || ""}\n</context_before>`);
  parts.push(`<selection>\n${ctx.selection}\n</selection>`);
  parts.push(`<context_after>\n${ctx.after || ""}\n</context_after>`);
  if (mode === "translate") {
    parts.push("Translate the selection.");
  } else if (ctx.question) {
    parts.push(`The reader's question about the selection: ${ctx.question}`);
  } else {
    parts.push("Explain the selection.");
  }
  return { role: "user", content: parts.join("\n\n") };
}

/**
 * Streams an explanation.
 * request: { context } for a new selection, or { messages } for a follow-up
 * (messages already ending with the new user turn). mode "translate" translates instead of explaining.
 */
async function explain({ apiKey, model, language, style, customStyle, request, signal, onText }) {
  const client = new Anthropic({ apiKey });
  // Thinking blocks are signed by the model that wrote them, so earlier answers go back as their text only.
  const messages = request.messages
    ? request.messages.map((m) => (m.role === "assistant" && Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type === "text") } : m))
    : [firstMessage(request.context, request.mode)];

  // Prompt caching: the system prompt is the same for every reader with the same style, so it sits behind a
  // cache breakpoint. A follow-up («Детальніше», a question) resends the whole card, so it also caches up
  // to its last message, and the next follow-up reads that back at a twentieth of the price. A first
  // request isn't cached past the system prompt: its book context is new every time.
  const params = {
    model,
    max_tokens: 16000,
    system: [{ type: "text", text: request.mode === "translate" ? translatePrompt(language) : systemPrompt(language, style, customStyle), cache_control: { type: "ephemeral" } }],
    messages,
    output_config: { effort: EFFORT[model] || "low" },
    ...(request.messages ? { cache_control: { type: "ephemeral" } } : {}),
  };

  let stream;
  if (FALLBACK_MODELS.has(model)) {
    stream = client.beta.messages.stream(
      { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
      { signal }
    );
  } else {
    stream = client.messages.stream(params, { signal });
  }
  stream.on("text", (text) => onText(text));

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Модель відмовилася відповідати на цей фрагмент.");
  }
  return {
    messages: [...messages, { role: "assistant", content: message.content }],
    model: message.model,
    truncated: message.stop_reason === "max_tokens",
    // Token counts for the server's usage stats (never shown to the reader).
    usage: message.usage,
  };
}

module.exports = { explain, systemPrompt, firstMessage };
