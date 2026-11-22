#!/usr/bin/env node
// Glossary trial for bug reports №28–29 («Бойня №5», «Про мишей і людей»): runs on a computer with the key and the
// books, keeps nothing on the server. Prompts in prompts.js (A = what runs now).
//   node scripts/gloss-try/try.js toc   <book.epub>              how the book's contents and notes are made
//   node scripts/gloss-try/try.js names <book.epub> <out.json>   names cards, variants A B C (Opus, book cached)
//   node scripts/gloss-try/try.js words <book.epub> <out.json>   underlined words on 3 parts, variants A B (Opus)
// ANTHROPIC_API_KEY from the environment. Prints the cost.
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const Anthropic = require("@anthropic-ai/sdk");
const g = require("../../server/glossary");
const { epubParts } = require("../../server/content");
const { measure } = require("../../server/aimeter");
const P = require("./prompts");

const MODEL = "claude-opus-5-5";
const [cmd, file, out] = process.argv.slice(2);
const plain = (s) => String(s || "").normalize("NFD").replace(/[̀́]/g, "").normalize("NFC");
let spent = 0;
const text = (m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const cost = (m) => (spent += measure(m.model, m.usage).cost);

// The sentence a form first occurs in, short, to judge an explanation by.
function sentenceOf(body, form) {
  const re = new RegExp(`(^|[^\\p{L}])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u");
  const m = re.exec(body);
  if (!m) return "";
  const at = m.index;
  const from = Math.max(0, Math.max(body.lastIndexOf(". ", at), body.lastIndexOf("! ", at), body.lastIndexOf("? ", at)) + 2);
  let to = body.slice(at).search(/[.!?…](\s|$)/);
  to = to < 0 ? body.length : at + to + 1;
  const s = body.slice(from, to).trim();
  return s.length > 240 ? `${s.slice(Math.max(0, at - from - 110), at - from + 110)}…` : s;
}

async function toc() {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const container = await zip.file("META-INF/container.xml").async("string");
  const opfPath = container.match(/full-path="([^"]+)"/)[1];
  const opf = await zip.file(opfPath).async("string");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "";
  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => ({ id: attr(m[0], "id"), href: decodeURIComponent(attr(m[0], "href")), type: attr(m[0], "media-type"), props: attr(m[0], "properties") }));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/g)].map((m) => ({ href: byId[attr(m[0], "idref")]?.href, linear: attr(m[0], "linear") || "yes" }));
  const inSpine = new Set(spine.map((s) => s.href));
  const read = async (href) => (await (zip.file(base + href) || zip.file(href))?.async("string")) || "";
  const report = { opf: opfPath, generator: opf.match(/<meta[^>]*name="generator"[^>]*>/)?.[0] || "", version: attr(opf.match(/<package\b[^>]*>/)?.[0] || "", "version"), files: items.length, spine: [], notInSpine: [], nav: [], ncx: [], links: { total: 0, sameFile: 0, otherFile: 0, toFileNotInSpine: 0, broken: 0, external: 0 }, epubTypes: {}, samples: [] };
  for (const i of items) if (/x?html/.test(i.type) && !inSpine.has(i.href)) report.notInSpine.push(i.href);
  const nav = items.find((i) => i.props.split(/\s+/).includes("nav"));
  if (nav) for (const m of (await read(nav.href)).matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) report.nav.push([g.key(m[2].replace(/<[^>]+>/g, "")).slice(0, 60), m[1]]);
  const ncx = items.find((i) => i.type === "application/x-dtbncx+xml");
  if (ncx) for (const m of (await read(ncx.href)).matchAll(/<navLabel>\s*<text>([\s\S]*?)<\/text>[\s\S]*?<content src="([^"]*)"/g)) report.ncx.push([m[1].trim().slice(0, 60), m[2]]);
  const docs = {};
  for (const i of items) if (/x?html/.test(i.type)) docs[i.href] = await read(i.href);
  const dir = (h) => (h.includes("/") ? h.slice(0, h.lastIndexOf("/") + 1) : "");
  const resolve = (from, href) => path.posix.normalize(dir(from) + href);
  for (const s of spine) {
    const html = docs[s.href] || "";
    const heads = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `h${m[1]} ${m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 50)}`);
    const classes = {};
    for (const m of html.matchAll(/<p\b[^>]*class="([^"]*)"[^>]*>([\s\S]{0,80})/g)) {
      const t = m[2].replace(/<[^>]+>/g, "").trim();
      if (t.length < 40) (classes[m[1]] ??= []).length < 3 && classes[m[1]].push(t);
    }
    const body = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    report.spine.push({ href: s.href, linear: s.linear, chars: body.length, heads: heads.slice(0, 12), headCount: heads.length, start: body.slice(0, 100), shortParas: Object.fromEntries(Object.entries(classes).slice(0, 8)) });
  }
  for (const [href, html] of Object.entries(docs)) {
    for (const m of html.matchAll(/epub:type="([^"]+)"/g)) report.epubTypes[m[1]] = (report.epubTypes[m[1]] || 0) + 1;
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/g)) {
      const h = m[1];
      report.links.total++;
      if (/^[a-z]+:/i.test(h)) {
        report.links.external++;
        continue;
      }
      const [f, id] = h.split("#");
      const target = f ? resolve(href, decodeURIComponent(f)) : href;
      if (!f) report.links.sameFile++;
      else report.links.otherFile++;
      const doc = docs[target];
      const found = doc != null && (!id || new RegExp(`\\b(id|name)="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(doc));
      if (!found) report.links.broken++;
      else if (!inSpine.has(target)) report.links.toFileNotInSpine++;
      if (report.samples.length < 4 && /\d/.test(m[0].replace(/<[^>]+>/g, ""))) {
        const at = doc && id ? doc.search(new RegExp(`\\b(id|name)="${id}"`)) : -1;
        report.samples.push({ in: href, link: m[0].slice(0, 240), target, inSpine: inSpine.has(target), found, around: at >= 0 ? doc.slice(Math.max(0, doc.lastIndexOf("<", at)), at + 260) : "" });
      }
    }
  }
  console.log(JSON.stringify(report, null, 1));
}

async function names() {
  const { chapters } = await epubParts(fs.readFileSync(file));
  const body = plain(chapters.join("\n\n"));
  const count = new Map();
  for (const m of body.matchAll(/(^|[^.!?…»"“”—–:\s]\s+)(\p{Lu}[\p{L}]+(?:['’ʼ-][\p{L}]+)*)/gu)) count.set(m[2], (count.get(m[2]) || 0) + 1);
  const list = [...count].sort((a, b) => b[1] - a[1]);
  const small = new Map();
  for (const m of body.matchAll(/\p{Ll}[\p{L}]*(?:['’ʼ-][\p{L}]+)*/gu)) small.set(g.key(m[0]), (small.get(g.key(m[0])) || 0) + 1);
  const caps = new Map();
  for (const [w, n] of list) caps.set(g.key(w), (caps.get(g.key(w)) || 0) + n);
  const listed = new Set([...caps.keys()].filter((k) => (small.get(k) || 0) <= caps.get(k)));
  const client = new Anthropic();
  const ask = async (prompt) => {
    const m = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        messages: [{ role: "user", content: [{ type: "text", text: body, cache_control: { type: "ephemeral" } }, { type: "text", text: `---\nСлова з великої літери (форма, скільки разів):\n${list.map(([w, n]) => `${w}\t${n}`).join("\n")}\n\n---\n${prompt}` }] }],
        output_config: { effort: "medium" },
      })
      .finalMessage();
    cost(m);
    console.error(`names: ${m.usage.input_tokens} in, ${m.usage.cache_read_input_tokens || 0} cached, ${m.usage.output_tokens} out, $${spent.toFixed(2)} so far`);
    return g.parseNames(text(m), listed);
  };
  const res = { book: path.basename(file), chars: body.length, candidates: list.length, variants: {} };
  res.variants.A = await ask(P.names.A); // writes the cache; B and C read it
  const [b, c] = await Promise.all([ask(P.names.B), ask(P.names.C)]);
  res.variants.B = b;
  res.variants.C = c;
  res.count = {};
  for (const v of Object.values(res.variants)) for (const k of Object.keys(v)) if (!res.count[k]) res.count[k] = (list.find(([w]) => g.key(w) === k) || [])[1] || 0;
  res.cost = spent;
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

async function words() {
  const { parts, chapters } = await g.partsOf(file);
  const pick = [...new Set([Math.min(1, parts.length - 1), Math.floor(parts.length / 2), Math.floor(parts.length * 0.8)])];
  const client = new Anthropic();
  const res = { book: path.basename(file), parts: parts.length, picked: pick, variants: {} };
  for (const [name, prompt] of Object.entries(P.words)) {
    const rows = [];
    await Promise.all(
      pick.map(async (i) => {
        const m = await client.messages.create({ model: MODEL, max_tokens: 20000, system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: parts[i] }], output_config: { effort: "medium" } });
        cost(m);
        for (const [form, gloss, level, word] of g.parseV2(text(m))) rows.push({ part: i, form, word, gloss, level, sentence: sentenceOf(parts[i], form) });
      }),
    );
    // The same tidy-up the reader's list gets before it is kept (names, common words, a meaning that repeats the word).
    const kept = g.clean(Object.fromEntries(rows.map((r) => [g.key(r.form), r.gloss])), chapters);
    res.variants[name] = rows.filter((r) => kept[g.key(r.form)]).sort((a, b) => a.part - b.part);
    console.error(`words ${name}: ${res.variants[name].length} kept of ${rows.length}, $${spent.toFixed(2)} so far`);
  }
  res.cost = spent;
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

({ toc, names, words })
  [cmd]()
  .then(() => console.error(`spent $${spent.toFixed(2)}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
