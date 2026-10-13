// Converts non-EPUB books (Kindle MOBI/AZW3, FB2, DOCX…) to EPUB with Calibre's ebook-convert.
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONVERTIBLE = ["mobi", "azw", "azw3", "azw4", "prc", "kfx", "fb2", "docx", "rtf", "odt", "txt", "htmlz", "lit", "pdb"];

const CANDIDATES = [
  "/Applications/calibre.app/Contents/MacOS/ebook-convert",
  path.join(os.homedir(), "Applications/calibre.app/Contents/MacOS/ebook-convert"),
  "/opt/homebrew/bin/ebook-convert",
  "/usr/local/bin/ebook-convert",
  "/usr/bin/ebook-convert",
];

function findEbookConvert() {
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function needsConversion(filePath) {
  return CONVERTIBLE.includes(path.extname(filePath).slice(1).toLowerCase());
}

class ConvertError extends Error {}

// Returns the path of a cached EPUB, converting only when the source changed since last time.
function toEpub(filePath, cacheDir) {
  const tool = findEbookConvert();
  if (!tool) {
    throw new ConvertError(
      "Щоб відкривати цей формат, потрібен Calibre. Встановіть його з calibre-ebook.com (або brew install --cask calibre) і спробуйте ще раз."
    );
  }
  const stat = fs.statSync(filePath);
  const key = crypto.createHash("sha1").update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest("hex").slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${key}.epub`);
  if (fs.existsSync(out)) return Promise.resolve(out);

  return new Promise((resolve, reject) => {
    execFile(tool, [filePath, out], { timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err && fs.existsSync(out)) return resolve(out);
      const log = `${stdout}\n${stderr}`;
      fs.rmSync(out, { force: true });
      if (/DRM/i.test(log)) {
        reject(new ConvertError("Ця книжка захищена DRM, тому Calibre не може її конвертувати."));
      } else {
        reject(new ConvertError(`Calibre не зміг конвертувати книжку.\n\n${log.trim().split("\n").slice(-5).join("\n")}`));
      }
    });
  });
}

module.exports = { CONVERTIBLE, needsConversion, toEpub, findEbookConvert, ConvertError };
