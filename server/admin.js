// What Claude costs, for the reader's stats (index.js collectStats). The page itself is the site's /admin/reader.

// $ per million tokens: [input, output, cache read, cache write]. Rough, for a sense of scale only.
const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES).find((k) => model.startsWith(k));
  return base ? PRICES[base] : null;
}

// Cost in USD of one { input, output, cacheRead, cacheWrite } token record; null when the model is unknown.
function cost(model, t) {
  const p = priceFor(model);
  if (!p) return null;
  return (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite * p[3]) / 1e6;
}

module.exports = { cost };
