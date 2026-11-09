// The look of the site's letters (Max, 2026-11-04: «беремо fancy версію», for the other letters too): the Friday
// letter's paper background, serif titles and a green button, as one shell. Every letter keeps its plain text too.
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const SERIF = "'Source Serif 4',Georgia,serif";

// Plain text as paragraphs (blank lines split them).
const paras = (text, { serif = true } = {}) =>
  String(text || "")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="${serif ? `font-family:${SERIF};font-size:16px;line-height:1.55;color:#3d3a33` : "font-size:15px;line-height:1.5;color:#3d3a33"};margin:16px 0 0">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
// A quoted text: a reader's words, with a thin rule on the left.
const quote = (text) => `<div style="border-left:2px solid #e4dfd5;padding-left:14px;margin-top:16px">${paras(text)}</div>`;
// A book: cover, title, author.
function book(b, site) {
  if (!b) return "";
  const src = b.cover ? (b.cover.startsWith("/") ? site + b.cover : b.cover) : "";
  const cover = src ? `<td style="vertical-align:top;width:44px"><img src="${esc(src)}" width="44" height="64" alt="${esc(b.title)}" style="width:44px;height:64px;object-fit:cover;border-radius:3px;display:block;background:#ded8cb;font-family:Georgia,serif;font-size:10px;color:#6b675f"></td>` : "";
  const href = b.href ? (b.href.startsWith("/") ? site + b.href : b.href) : "";
  const title = href ? `<a href="${esc(href)}" style="font-family:${SERIF};font-size:16px;color:#1b1a17;text-decoration:none">«${esc(b.title)}»</a>` : `<span style="font-family:${SERIF};font-size:16px">«${esc(b.title)}»</span>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:16px 0 0"><tr>${cover}<td style="vertical-align:middle;padding-left:${cover ? 14 : 0}px">${title}${b.author ? `<div style="font-size:13px;color:#6b675f;margin-top:3px">${esc(b.author)}</div>` : ""}${b.note ? `<div style="font-size:14px;line-height:1.45;color:#3d3a33;margin-top:5px">${b.note}</div>` : ""}</td></tr></table>`;
}

// The whole letter. `body` is HTML; `button` { text, href }; `off` the one-click «не надсилати» link and its words.
// `motto`: words after the last footer link (the welcome letter's «: читай більше»).
function letter({ site, title, section = "", kicker = "", heading = "", body = "", button = null, off = null, footer = "Ви отримуєте ці листи як читач chytai.org.ua", motto = "" }) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f7f4ee;color:#1b1a17;font-family:Onest,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="max-width:560px;margin:0 auto;padding:32px 20px 40px">
  <div style="font-weight:600;font-size:15px"><a href="${site}" style="color:#1b1a17;text-decoration:none">Chytai</a>${section ? ` <span style="color:#6b675f;font-weight:400;margin-left:10px">${esc(section)}</span>` : ""}</div>
  ${kicker ? `<div style="margin-top:24px;font-size:13px;color:#6b675f">${kicker}</div>` : ""}
  ${heading ? `<h1 style="font-family:${SERIF};font-weight:500;font-size:26px;line-height:1.25;margin:${kicker ? 8 : 24}px 0 0">${heading}</h1>` : ""}
  ${body}
  ${button ? `<div style="margin:26px 0 0"><a href="${esc(button.href)}" style="display:inline-block;background:#266741;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:11px 20px;border-radius:999px">${esc(button.text)}</a></div>` : ""}
  <div style="border-top:1px solid #1b1a17;margin-top:36px;padding-top:14px;font-size:12px;line-height:1.6;color:#6b675f">
    ${footer ? `${esc(footer)}<br>` : ""}${off ? `<a href="${esc(off.href)}" style="color:#6b675f">${esc(off.text)}</a> · ` : ""}<a href="${site}/settings/mail" style="color:#6b675f">Налаштування</a> · <a href="${site}" style="color:#6b675f">chytai.org.ua</a>${motto ? esc(motto) : ""}
  </div>
</div></body></html>`;
}

module.exports = { esc, paras, quote, book, letter, SERIF };
