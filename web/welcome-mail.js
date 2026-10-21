// The welcome letter (Max, 2026-10-21: «welcome email для нових реєстрацій, там буде про сайт і про групу в
// тг для користувачів»): one plain letter to every new reader right after sign-up. Max writes the text in
// web/welcome-mail.md: the first line is «Тема: …», then Markdown paragraphs (a single line break stays one); {name}, {username} and {site}
// are filled in. It goes out only while meta welcome:on is "1" (the owner switches it on
// /welcome-mail/preview); readers who signed up before that get nothing. One letter, nothing to
// unsubscribe from; nothing is tracked.
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const pages = require("./pages");

const FILE = path.join(__dirname, "welcome-mail.md");
const esc = pages.esc;

class WelcomeMail {
  constructor({ store, auth, site, log = console.log }) {
    Object.assign(this, { store, auth, site, log });
  }
  get on() {
    return this.store.db.get("welcome:on") === "1";
  }
  setOn(on) {
    this.store.db.set("welcome:on", on ? "1" : "0");
  }

  // The letter for a reader: { subject, text, html }.
  render(reader) {
    const vars = { name: reader.name, username: reader.username, site: this.site };
    const fill = (s, html) => s.replace(/\{(name|username|site)\}/g, (_, k) => (html && (k === "name" || k === "username") ? esc(vars[k]) : vars[k]));
    const src = fs.readFileSync(FILE, "utf8").trim();
    const [first, ...rest] = src.split("\n");
    const subject = fill(first.replace(/^Тема:\s*/, ""), false);
    const paras = rest.join("\n").trim().split(/\n\s*\n/);
    // Plain text: links as «text (url)», unless the text is the address itself.
    const text = paras.map((p) => fill(p, false).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (u.replace(/^https?:\/\//, "").startsWith(t) ? u : `${t} (${u})`))).join("\n\n");
    const body = paras.map((p) => `<p style="font-size:16px;line-height:1.55;color:#3d3a33;margin:0 0 16px">${marked.parseInline(fill(p, true)).replace(/<a /g, '<a style="color:#1b1a17" ').replace(/\n/g, "<br>")}</p>`).join("\n  ");
    const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f7f4ee;color:#1b1a17;font-family:Onest,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="max-width:560px;margin:0 auto;padding:32px 20px 40px">
  <div style="font-weight:600;font-size:15px;margin-bottom:26px"><a href="${this.site}" style="color:#1b1a17;text-decoration:none">Chytai</a></div>
  ${body}
  <div style="border-top:1px solid #1b1a17;margin-top:30px;padding-top:14px;font-size:12px;line-height:1.6;color:#6b675f">
    Цей лист приходить один раз, після реєстрації. <a href="${this.site}/settings" style="color:#6b675f">Налаштування</a> · <a href="${this.site}" style="color:#6b675f">chytai.org.ua</a>
  </div>
</div></body></html>`;
    return { subject, text, html };
  }

  async sendTo(reader) {
    const letter = this.render(reader);
    await this.auth.send(reader.email, letter.subject, letter.text, { html: letter.html });
    return letter;
  }
  // Right after sign-up; never blocks or breaks it.
  newReader(reader) {
    if (!this.on || !reader.email) return;
    this.sendTo(reader).then(
      () => this.log(`welcome mail → @${reader.username}`),
      (e) => this.log(`welcome mail to @${reader.username} failed: ${e.message}`),
    );
  }
}

module.exports = { WelcomeMail };
