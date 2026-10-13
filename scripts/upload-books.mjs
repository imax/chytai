#!/usr/bin/env node
// Uploads EPUB/PDF files from a folder to the web reader's shared library.
//   node scripts/upload-books.mjs https://chytai.fly.dev "~/Library/Mobile Documents/com~apple~CloudDocs/Books"
// Asks for name/password unless READER_NAME and READER_PASSWORD are set.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

const [server, folderArg] = process.argv.slice(2);
if (!server || !folderArg) {
  console.error("usage: upload-books.mjs <server url> <folder>");
  process.exit(1);
}
const folder = folderArg.replace(/^~/, os.homedir());
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const name = process.env.READER_NAME || (await rl.question("Ім'я: "));
const password = process.env.READER_PASSWORD || (await rl.question("Пароль: "));
rl.close();

const login = await fetch(`${server}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ name, password }),
  redirect: "manual",
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (login.status !== 302 || !cookie) {
  console.error("Не вдалося увійти:", login.status);
  process.exit(1);
}

const files = fs.readdirSync(folder).filter((f) => /\.(epub|pdf)$/i.test(f) && !f.startsWith("."));
console.log(`${files.length} книжок у ${folder}`);
for (const f of files) {
  const file = path.join(folder, f);
  const st = fs.statSync(file);
  if (st.size > 0 && st.blocks === 0) {
    console.log(`  ⚠ ${f}: лише в iCloud, завантажте файл на Mac (brctl download) і повторіть`);
    continue;
  }
  const res = await fetch(`${server}/api/books/${encodeURIComponent(f.normalize("NFC"))}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
    body: fs.readFileSync(file),
  });
  console.log(`  ${res.ok ? "✓" : "✗"} ${f} (${(st.size / 1e6).toFixed(1)} МБ)${res.ok ? "" : " " + res.status}`);
}
