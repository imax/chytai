const Anthropic = require("@anthropic-ai/sdk");

// Models that accept the server-side refusal fallback ("default" picks the substitute by refusal category).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

// Quick answers for everyday reading; the deep model gets more room to think.
const EFFORT = {
  "claude-fable-5-1": "medium",
};

function systemPrompt(language) {
  return `You are a reading companion built into an e-book reader. The reader highlights a word, phrase or passage while reading and you explain it in place, like a smart margin note, so they don't have to leave the book.

Always answer in ${language}, even when the book is in another language. Quote the original wording when it helps.

Tailor the answer to what was selected:
- A single word or short term: its meaning in this exact context (not a list of dictionary senses), pronunciation or etymology only if useful, and a note if the author uses it unusually.
- A phrase, idiom or allusion: what it means here, where it comes from, and what the author is signalling by using it.
- A sentence or paragraph: what it says in plain language, why it matters in the argument or story, and any references, history, people, concepts or subtext a reader might miss.

Use the surrounding text and the book/chapter to resolve who "he", "it" or "this" refers to and to stay consistent with the book. Don't summarise the surrounding text back unless it is needed, and avoid spoilers beyond the passage shown.

Let the length follow the need. Give the shortest answer that fully explains the selection: a plain word usually needs one or two sentences; a dense allusion or a key passage may need a short paragraph or two. Mention only the points from the list above that matter here, not all of them, and never pad. Under each answer the reader has a "Детальніше" (more detail) button, so leave background and side topics for that. When they press it, go deeper: background, connections and subtext, in a few short paragraphs at most.

Start with the explanation itself, no preamble. Use Markdown sparingly (bold for key terms, short lists). If something is genuinely ambiguous or you are unsure about a fact, say so in one line rather than guessing.

The reader may ask follow-up questions; answer them in the same spirit.`;
}

function firstMessage(ctx, deep) {
  const parts = [];
  if (ctx.bookTitle) parts.push(`<book>${ctx.bookTitle}${ctx.author ? ` by ${ctx.author}` : ""}</book>`);
  if (ctx.chapter) parts.push(`<chapter>${ctx.chapter}</chapter>`);
  parts.push(`<context_before>\n${ctx.before || ""}\n</context_before>`);
  parts.push(`<selection>\n${ctx.selection}\n</selection>`);
  parts.push(`<context_after>\n${ctx.after || ""}\n</context_after>`);
  if (ctx.question) {
    parts.push(`The reader's question about the selection: ${ctx.question}`);
  } else if (deep) {
    parts.push(
      "Explain the selection in depth: unpack the ideas, their background and connections, and anything a careful reader would want to know. Aim for a thorough but readable note, a few short paragraphs at most."
    );
  } else {
    parts.push("Explain the selection.");
  }
  return { role: "user", content: parts.join("\n\n") };
}

/**
 * Streams an explanation.
 * request: { context, deep } for a new selection, or { messages } for a follow-up
 * (messages already ending with the new user turn).
 */
async function explain({ apiKey, model, language, request, signal, onText }) {
  const client = new Anthropic({ apiKey });
  const messages = request.messages || [firstMessage(request.context, request.deep)];

  const params = {
    model,
    max_tokens: 16000,
    system: systemPrompt(language),
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
    // Full assistant content (incl. thinking blocks) goes back unchanged on follow-ups.
    messages: [...messages, { role: "assistant", content: message.content }],
    model: message.model,
    truncated: message.stop_reason === "max_tokens",
    // Token counts for the server's usage stats (never shown to the reader).
    usage: message.usage,
  };
}

module.exports = { explain, systemPrompt, firstMessage };
