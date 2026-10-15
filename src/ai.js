const Anthropic = require("@anthropic-ai/sdk");

// Models that accept the server-side refusal fallback ("default" picks the substitute by refusal category).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

// Quick answers for everyday reading; the deep model gets more room to think.
const EFFORT = {
  "claude-fable-5-1": "medium",
};

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

// Translation: a plain, faithful translation of the selection (Mykola's idea), on a cheaper model.
function translatePrompt(language) {
  return `You are a translator built into an e-book reader. The reader highlights a word, phrase or passage and you translate it in place.

Translate the selection into ${language}. If the selection is already in ${language}, translate it into English instead.

Give the translation itself first, with no preamble and no quotes around it. Keep the meaning, tone and register of the original, and render idioms by sense rather than word for word. Use the surrounding text and the book/chapter only to resolve ambiguity (who "he" or "it" is, which sense of a word is meant); translate only the selection. Keep names as they are usually written in ${language}.

For a single word or a short term, add one short line with the other likely meanings only if the context leaves real doubt. For a longer passage, add nothing after the translation unless a pun, wordplay or cultural reference is lost; then add one short line in ${language} saying what is lost.

The reader may ask follow-up questions about the translation; answer them briefly in ${language}.`;
}

function firstMessage(ctx, deep, mode) {
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
 * (messages already ending with the new user turn). mode "translate" translates instead of explaining.
 */
async function explain({ apiKey, model, language, style, customStyle, request, signal, onText }) {
  const client = new Anthropic({ apiKey });
  const messages = request.messages || [firstMessage(request.context, request.deep, request.mode)];

  const params = {
    model,
    max_tokens: 16000,
    system: request.mode === "translate" ? translatePrompt(language) : systemPrompt(language, style, customStyle),
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
