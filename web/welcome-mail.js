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
  constructor({ store, auth, site, ownerId = "owner", log = console.log }) {
    Object.assign(this, { store, auth, site, ownerId, log });
  }
  // Who already got it (meta welcome:sent, a list of reader ids), so nobody gets it twice.
  sent() {
    return new Set(JSON.parse(this.store.db.get("welcome:sent") || "[]"));
  }
  markSent(id) {
    const s = this.sent();
    s.add(id);
    this.store.db.set("welcome:sent", JSON.stringify([...s]));
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
    const text = paras.map((p) => fill(p, false).replace(/^Кнопка:\s*\[([^\]]+)\]\(([^)]+)\)\s*$/, "$1: $2").replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (u.replace(/^https?:\/\//, "").startsWith(t) ? u : `${t} (${u})`))).join("\n\n");
    // A paragraph «Кнопка: [Текст](адреса)» is a green button (Max, 2026-10-22: «кнопку Додати книжки в welcome email»).
    const BUTTON = /^Кнопка:\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;
    const body = paras
      .map((p) => {
        const b = BUTTON.exec(p.trim());
        if (b) return `<p style="margin:6px 0 22px"><a href="${esc(fill(b[2], false))}" style="display:inline-block;background:#24613f;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:999px">${esc(fill(b[1], false))}</a></p>`;
        return `<p style="font-size:16px;line-height:1.55;color:#3d3a33;margin:0 0 16px">${marked.parseInline(fill(p, true)).replace(/<a /g, '<a style="color:#1b1a17" ').replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n  ");
    const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f7f4ee;color:#1b1a17;font-family:Onest,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="max-width:560px;margin:0 auto;padding:32px 20px 40px">
  <div style="font-weight:600;font-size:15px;margin-bottom:26px"><a href="${this.site}" style="color:#1b1a17;text-decoration:none">Chytai</a></div>
  ${body}
  <div style="border-top:1px solid #1b1a17;margin-top:30px;padding-top:14px;font-size:12px;line-height:1.6;color:#6b675f">
    <a href="${this.site}/settings/mail" style="color:#6b675f">Налаштування</a> · <a href="${this.site}" style="color:#6b675f">chytai.org.ua</a>: читай більше
  </div>
</div></body></html>`;
    return { subject, text, html };
  }

  async sendTo(reader, { record = false } = {}) {
    const letter = this.render(reader);
    await this.auth.send(reader.email, letter.subject, letter.text, { html: letter.html });
    if (record) this.markSent(reader.id);
    return letter;
  }
  // Readers who signed up since a date (ISO) and have not had it yet: for a one-off catch-up send (Max,
  // 2026-10-21: «розішлемо всім хто реєструвався цього тижня»).
  missed(since) {
    const sent = this.sent();
    return this.auth.readers().filter((r) => r.email && r.id !== this.ownerId && r.created >= since && !sent.has(r.id));
  }
  async catchUp(since) {
    const done = [], errors = [];
    for (const r of this.missed(since)) {
      try {
        await this.sendTo(r, { record: true });
        done.push(r.username);
      } catch (e) {
        errors.push(`@${r.username}: ${e.message}`);
      }
      await new Promise((ok) => setTimeout(ok, 600)); // Resend allows 2 a second
    }
    this.log(`welcome mail catch-up since ${since}: ${done.length} sent, ${errors.length} failed`);
    return { done, errors };
  }
  // Right after sign-up; never blocks or breaks it.
  newReader(reader) {
    if (!this.on || !reader.email) return;
    this.sendTo(reader, { record: true }).then(
      () => this.log(`welcome mail → @${reader.username}`),
      (e) => this.log(`welcome mail to @${reader.username} failed: ${e.message}`),
    );
  }
}

module.exports = { WelcomeMail };
