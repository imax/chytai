// Rebuilds web/seed/shelves.json (the shelves the server starts with) from the normalised catalogs in
// web/catalogs/. The server refreshes the live shelves itself every day (web/catalogs.js); this is for
// the seed, after fetching the catalogs by hand:
//   node web/scripts/build-shelves.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { SOURCES, buildShelves } = createRequire(import.meta.url)("../catalogs.js");
const CATALOGS = path.resolve("web/catalogs");
const OUT = path.resolve("web/seed/shelves.json");

const raw = {};
for (const src of SOURCES) raw[src.id] = JSON.parse(fs.readFileSync(path.join(CATALOGS, `${src.id}.json`), "utf8"));
const built = buildShelves(raw);
// The baseline is the day the shelves were first built; later refreshes mark items that appeared after it as new.
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
fs.writeFileSync(OUT, JSON.stringify({ ...built, baseline: prev.baseline || built.fetched }, null, 1) + "\n");
for (const s of built.shelves) console.log(s.id, s.items.length);
