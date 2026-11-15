// Every Claude call this process makes, counted (Max, 2026-11-15, after a loop redid the same overviews every two
// hours for weeks and only the Anthropic console showed it: «давай подумаємо щоб рахувати теж токени»).
// install() patches the SDK's messages.create and messages.stream (plain and beta) once, so no caller can slip past
// it, however its client was made. Each answer goes to `onUsage` as { feature, model, calls, input, output,
// cacheRead, cacheWrite, searches, cost }: feature = the file that made the call (advice, ask, ai, paper…), cost in
// dollars at list prices. A stream cut off midway counts what it had received. Used by the site (web/aiusage.js) and
// the reader (server/index.js), each with its own store.
const path = require("path");

// Dollars per million tokens: input, output, cache read, cache write (5 minutes). Update when models change.
const PRICES = {
  "claude-fable-5-2": [8, 40, 0.2, 10],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
const SEARCH = 0.01; // one web search

const priceOf = (model) => PRICES[model] || PRICES[Object.keys(PRICES).find((k) => String(model || "").startsWith(k))] || PRICES["claude-opus-5-5"];

function measure(model, u = {}) {
  const p = priceOf(model);
  const r = {
    model: model || "?",
    calls: 1,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    searches: u.server_tool_use?.web_search_requests || 0,
  };
  r.cost = (r.input * p[0] + r.output * p[1] + r.cacheRead * p[2] + r.cacheWrite * p[3]) / 1e6 + r.searches * SEARCH;
  return r;
}

// The first file in the call's stack that is ours (not the SDK's, not this one): "advice", "ask", "ai", "paper"…
function featureOf(stack) {
  for (const line of String(stack || "").split("\n").slice(1)) {
    const m = line.match(/\(?([^()\s]+\.m?js):\d+:\d+\)?$/);
    if (!m || /node_modules|node:|aimeter\.js/.test(m[1])) continue;
    return path.basename(m[1]).replace(/\.m?js$/, "");
  }
  return "?";
}

let sink = null;
let patched = false;

function emit(feature, model, usage) {
  if (!sink || !usage) return;
  try {
    sink({ feature, ...measure(model, usage) });
  } catch (e) {
    console.error(`aimeter: ${e.message}`);
  }
}

function patch(proto) {
  // A local fake SDK (CLAUDE.md: `node -r mock.js`) has plain objects: patching Object.prototype broke every header.
  if (!proto || proto === Object.prototype || typeof proto.create !== "function") return;
  const create = proto.create;
  proto.create = function (params, ...rest) {
    const p = create.call(this, params, ...rest);
    // A stream:true create is stream()'s own inner call (counted there) or a caller reading events itself.
    if (!params?.stream && p && typeof p.then === "function") {
      const feature = featureOf(new Error().stack);
      p.then(
        (m) => emit(feature, m?.model || params?.model, m?.usage),
        () => {}
      );
    }
    return p;
  };
  const stream = proto.stream;
  if (typeof stream !== "function") return;
  proto.stream = function (params, ...rest) {
    const s = stream.call(this, params, ...rest);
    const feature = featureOf(new Error().stack);
    let snap = null;
    let done = false;
    const once = (m) => {
      if (done || !m) return;
      done = true;
      emit(feature, m.model || params?.model, m.usage);
    };
    try {
      s.on("streamEvent", (_e, snapshot) => (snap = snapshot));
      s.on("finalMessage", once);
      s.on("abort", () => once(snap));
      s.on("error", () => once(snap));
    } catch {}
    return s;
  };
}

// Once per process. `onUsage` gets every answer; a later install() only changes where they go.
function install(onUsage) {
  sink = onUsage;
  if (patched) return;
  patched = true;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const c = new Anthropic({ apiKey: "aimeter" });
    patch(Object.getPrototypeOf(c.messages));
    patch(Object.getPrototypeOf(c.beta.messages));
  } catch (e) {
    console.error(`aimeter: not installed: ${e.message}`);
  }
}

module.exports = { install, measure, featureOf, PRICES };
