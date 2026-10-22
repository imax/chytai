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
  return text ? `\n\nThe reader's chosen style overrides the length and format guidance above (but a translation of a foreign-language selection still comes first):\n${text}` : "";
}

function systemPrompt(language, style, custom) {
  return `You are a reading companion built into an e-book reader. The reader highlights a word, phrase or passage while reading and you explain it in place, like a smart margin note, so they don't have to leave the book.

Always answer in ${language}, even when the book is in another language. Quote the original wording when it helps.

Tailor the answer to what was selected:
- A single word or short term: its meaning in this exact context (not a list of dictionary senses), pronunciation or etymology only if useful, and a note if the author uses it unusually.
- A phrase, idiom or allusion: what it means here, where it comes from, and what the author is signalling by using it.
- A sentence or paragraph: what it says in plain language, why it matters in the argument or story, and any references, history, people, concepts or subtext a reader might miss.

When asked to explain a selection that is in a language other than ${language}, start with its translation into ${language}: a faithful translation of the selection only, in italics, as its own first paragraph, keeping the tone and rendering idioms by sense. For a single foreign word or short term, a separate translation line is not needed: give its meaning here in the first sentence. If the selection is already in ${language}, don't translate. Don't repeat the translation in later answers.

Use the surrounding text and the book/chapter to resolve who "he", "it" or "this" refers to and to stay consistent with the book. Don't summarise the surrounding text back unless it is needed, and avoid spoilers beyond the passage shown.

The first explanation is a quick note in the margin, not an essay: the translation if one is needed, then at most two short sentences (about 40 words in all) with the single most useful thing to know about this passage here. A word needs one sentence. No background, etymology, plot summary or second point: all of that waits until the reader presses "Детальніше", and never write a "Детальніше" section yourself. Never invent text that is not in the book excerpt. Under the note the reader has a "Детальніше" (more detail) button; when they press it, give the full explanation like a well-read friend would: what it means here and why it matters, plus the references, history, people, concepts or subtext a reader might miss (skip the points from the list above that don't apply), in a few short paragraphs or bullets at most.

Start with the explanation itself, no preamble. Use Markdown sparingly (bold for key terms, short lists). If something is genuinely ambiguous or you are unsure about a fact, say so in one line rather than guessing.

The reader may also ask their own question about the selection, or follow-up questions; answer them fully but to the point, in the same spirit.${styleSection(style, custom)}`;
}

function firstMessage(ctx, quick) {
  const parts = [];
  if (ctx.bookTitle) parts.push(`<book>${ctx.bookTitle}${ctx.author ? ` by ${ctx.author}` : ""}</book>`);
  if (ctx.chapter) parts.push(`<chapter>${ctx.chapter}</chapter>`);
  parts.push(`<context_before>\n${ctx.before || ""}\n</context_before>`);
  parts.push(`<selection>\n${ctx.selection}\n</selection>`);
  parts.push(`<context_after>\n${ctx.after || ""}\n</context_after>`);
  if (ctx.question) {
    parts.push(`The reader's question about the selection: ${ctx.question}`);
  } else if (quick) {
    parts.push("Give the quick note on the selection: the translation if needed, then at most two short sentences.");
  } else {
    parts.push("Explain the selection.");
  }
  return { role: "user", content: parts.join("\n\n") };
}

/**
 * Streams an explanation.
 * request: { context } for a new selection, or { messages } for a follow-up
 * (messages already ending with the new user turn).
 */
async function explain({ apiKey, model, language, style, customStyle, request, signal, onText }) {
  const client = new Anthropic({ apiKey });
  // The quick note and the follow-ups run on different models, and thinking blocks are signed by the
  // model that wrote them, so earlier answers go back as their text only.
  const messages = request.messages
    ? request.messages.map((m) => (m.role === "assistant" && Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type === "text") } : m))
    : [firstMessage(request.context, request.quick)];

  const params = {
    model,
    max_tokens: 16000,
    system: systemPrompt(language, style, customStyle),
    messages,
    output_config: { effort: EFFORT[model] || "low" },
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
