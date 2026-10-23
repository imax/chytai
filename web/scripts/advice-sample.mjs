// A sample of «Чи варто читати?» from the command line, for checking the prompt before shipping:
//   node web/scripts/advice-sample.mjs <book slug or id> [more slugs…]
// Reads ANTHROPIC_API_KEY from the environment or the repo's .env, seeds a throwaway library from
// web/seed (the owner's shelf) in a temp folder, asks Claude as the owner and prints the answers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {}
const { Store, OWNER } = require("../store");
const { Social } = require("../social");
const { Advice } = require("../advice");

const slugs = process.argv.slice(2);
if (!slugs.length || !process.env.ANTHROPIC_API_KEY) {
  console.error("usage: ANTHROPIC_API_KEY=… node web/scripts/advice-sample.mjs <slug>…");
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chytai-advice-"));
const store = new Store(path.join(dir, "web"));
const social = new Social(store, () => true);
const advice = new Advice({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY, log: console.error });
console.error(`shelf: ${advice.shelfText(OWNER).count} books`);
for (const slug of slugs) {
  const book = store.bookPage(store.resolve(slug));
  if (!book) {
    console.log(`\n### ${slug}: not found\n`);
    continue;
  }
  const t0 = Date.now();
  try {
    const a = await advice.ask(OWNER, book, { fresh: true });
    console.log(`\n### ${book.title} — ${book.author || ""} (${a.model}, ${((Date.now() - t0) / 1000).toFixed(1)} s)\n\n${a.text}\n`);
  } catch (e) {
    console.log(`\n### ${book.title}: ${e.message}\n`);
  }
}
console.error(JSON.stringify(advice.totals()));
fs.rmSync(dir, { recursive: true, force: true });
