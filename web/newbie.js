// The newcomer's day-2 letter (Max, 2026-11-09: «про новачку лист на другий день. попросити його оцінити хоча б
// три книжки»): six books most readers here have read, each with five star links. One tap = /do/rate/<book>/<n>,
// the book is on the shelf as read with that rating, and /start shows the rest. Sent through the shared letter
// shell with kind "newbie", so it is in the send log and counts toward the two-a-day cap (maillog.js).
const M = require("./mailhtml");

const SUBJECT = "Оцініть три книжки";

// `books`: [{ title, author, cover, href, slug }]. `link(path)` turns a site path into a tracked URL.
function compose({ site, reader, books, link = (p) => site + p }) {
  const star = (slug, n) => `<a href="${M.esc(link(`/do/rate/${encodeURIComponent(slug)}/${n}`))}" title="${n} з 5" style="color:#c9c2b4;text-decoration:none;font-size:24px;line-height:1;padding:0 3px">★</a>`;
  const rows = books.map((b) => M.book({ ...b, note: `<div style="margin-top:6px;white-space:nowrap">${[1, 2, 3, 4, 5].map((n) => star(b.slug, n)).join("")}</div>` }, site)).join("");
  const html = M.letter({
    site,
    title: SUBJECT,
    heading: "Що з цього ви читали?",
    body: `${M.paras("Оцініть хоча б три, і ми підберемо, що читати далі.")}${rows}`,
    button: { text: "Більше книжок", href: link("/start") },
  });
  const text = [
    "Що з цього ви читали?",
    "",
    "Оцініть хоча б три книжки, і ми підберемо, що читати далі.",
    "",
    ...books.map((b) => `«${b.title}»${b.author ? `, ${b.author}` : ""}`),
    "",
    `Оцінити: ${link("/start")}`,
  ].join("\n");
  return { subject: SUBJECT, html, text };
}

const SEND_HOUR = 10; // Kyiv, with the «Хочу» letters
const kyiv = (d) => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
const dayKyiv = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const DAY = 86400000;

// Once a day from 10:00 Kyiv (not on Fridays: that day only the digest goes), to readers who signed up 1 to 7
// days ago, have an e-mail, fewer than three ratings, and never got it (meta newbie:sent). The week's window
// means a missed day (a deploy, the cap) only delays the letter.
class NewbieMail {
  constructor({ store, auth, site, books, rated, log = console.log }) {
    Object.assign(this, { store, auth, site, books, rated, log });
  }
  sent() {
    return new Set(JSON.parse(this.store.db.get("newbie:sent") || "[]"));
  }
  mark(id) {
    const s = this.sent();
    s.add(id);
    this.store.db.set("newbie:sent", JSON.stringify([...s]));
  }
  due(now = new Date()) {
    const sent = this.sent();
    const t = now.getTime();
    return this.auth.readers().filter((r) => r.email && !sent.has(r.id) && t - Date.parse(r.created) >= DAY && t - Date.parse(r.created) < 7 * DAY);
  }
  render(reader) {
    const books = this.books(reader).slice(0, 6);
    if (books.length < 3) return null;
    const A = require("./admin");
    const l = compose({ site: this.site, reader, books, link: (p) => this.site + p });
    return { ...l, text: A.mailLinks(l.text, this.site, "newbie"), html: A.mailLinks(l.html, this.site, "newbie", true) };
  }
  async run({ now = new Date() } = {}) {
    const out = { started: now.toISOString(), sent: 0, skipped: 0, errors: [] };
    for (const r of this.due(now)) {
      try {
        if (this.rated(r.id) >= 3) {
          this.mark(r.id); // rated enough on their own: no letter, now or later
          out.skipped++;
          continue;
        }
        if (this.auth.mailLog && !this.auth.mailLog.room(r.id, now)) continue; // two letters today: tomorrow
        const l = this.render(r);
        if (!l) continue;
        await this.auth.send(r.email, l.subject, l.text, { html: l.html, kind: "newbie" });
        this.mark(r.id);
        out.sent++;
        this.log(`newbie mail @${r.username}`);
      } catch (e) {
        out.errors.push(`@${r.username}: ${e.message}`);
      }
    }
    out.finished = new Date().toISOString();
    this.store.db.set("newbie:last", JSON.stringify(out));
    return out;
  }
  schedule() {
    const tick = () => {
      const db = this.store.db;
      const today = dayKyiv(new Date());
      const now = kyiv(new Date());
      if (now.getHours() < SEND_HOUR || now.getDay() === 5 || db.get("newbie:lastRun") === today || db.get("digest:running")) return;
      db.set("newbie:lastRun", today);
      this.run().catch((e) => this.log(`newbie mail run failed: ${e.message}`));
    };
    setInterval(tick, 10 * 60 * 1000).unref();
    setTimeout(tick, 3 * 60 * 1000).unref();
  }
}

module.exports = { compose, SUBJECT, NewbieMail };
