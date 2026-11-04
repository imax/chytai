// A letter to every reader about a new Club topic (Max, 2026-11-04: «не чекати п'ятничного дайджеста… коли
// з'явилась перша відповідь. Тобто, що це не спам, а я не видалив цю тему, там хтось щось відповів… залучати
// інших людей до обговорень»). A topic is queued when someone other than its author first answers it; the jobs
// process sends the oldest queued topic, at most one such letter a day, between 9:00 and 21:00 Kyiv time.
// Who gets it: readers with an e-mail who keep both the Friday letter and «Нові теми в Клубі» on, apart from
// the topic's author and those already in it. «Не надсилати» in the letter switches only these letters off.
const DAY = 86400000;
const GAP = 20 * 3600 * 1000; // between two such letters
const FRESH = 7 * DAY; // a topic answered later than this after it began is not news any more
const HOURS = [9, 21]; // Kyiv time
const BATCH = 100; // Resend's batch limit
// Off: the letters go to the owner alone, once per topic, to see them in his mail first (Max decides).
const ON = true; // Max OK 2026-11-04
// Plain text, or the Friday letter's look as well (Max picks after seeing both, 2026-11-04).
const HTML = true;

class ClubMail {
  constructor({ store, auth, club, digest, site, ownerId = "owner", log = console.log }) {
    Object.assign(this, { store, auth, club, digest, site, ownerId, log });
    const db = store.db;
    db.exec("CREATE TABLE IF NOT EXISTS club_announce (topic TEXT PRIMARY KEY, queued TEXT NOT NULL, sent TEXT, n INTEGER)");
    if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "topic_mail")) db.exec("ALTER TABLE readers ADD COLUMN topic_mail INTEGER NOT NULL DEFAULT 1");
    // Topics from before these letters never go out, apart from Геннадій's about Umberto Eco, the first one (Max).
    if (!store.db.get("clubmail:started")) {
      const now = new Date().toISOString();
      db.prepare("INSERT OR IGNORE INTO club_announce (topic, queued, sent, n) SELECT id, ?, 'before', 0 FROM club_topics WHERE id <> 'f63ffea272c4'").run(now);
      db.prepare("INSERT OR IGNORE INTO club_announce (topic, queued) SELECT id, ? FROM club_topics WHERE id = 'f63ffea272c4'").run(now);
      store.db.set("clubmail:started", now);
    }
  }
  enabled(readerId) {
    const r = this.auth.reader(readerId);
    return !!r && r.topic_mail !== 0;
  }
  setEnabled(readerId, on) {
    this.store.db.prepare("UPDATE readers SET topic_mail = ? WHERE id = ?").run(on ? 1 : 0, readerId);
  }
  offUrl(readerId) {
    return `${this.site}/club-mail/topics/off/${encodeURIComponent(readerId)}/${this.digest.token(readerId)}`;
  }

  // After an answer: the topic's first answer by someone else queues it.
  answered(topic, readerId) {
    if (!topic || readerId === topic.reader.id || Date.now() - Date.parse(topic.created) > FRESH) return;
    this.store.db.prepare("INSERT OR IGNORE INTO club_announce (topic, queued) VALUES (?, ?)").run(topic.id, new Date().toISOString());
  }

  recipients(topic) {
    const inside = new Set([topic.reader.id, ...this.club.watchers(topic.id), ...this.club.posts(topic.id).map((p) => p.reader.id)]);
    // Not those who signed up today: they have just had the welcome letter (Max, 2026-11-04).
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    const joinedToday = (r) => r.created && new Date(r.created).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) === today;
    return this.auth.readers().filter((r) => r.email && r.digest !== 0 && r.topic_mail !== 0 && !inside.has(r.id) && !joinedToday(r));
  }

  // The letter for a reader: { to, subject, text, headers }.
  letter(topic, reader, { withHtml = HTML } = {}) {
    const off = this.offUrl(reader.id);
    const t = topic;
    const text = String(t.text || "").trim().replace(/\n{3,}/g, "\n\n");
    const cut = text.length > 700 ? `${text.slice(0, 700).replace(/\s+\S*$/, "")}…` : text;
    const body = [
      `Нова тема в Клубі Chytai від ${t.reader.name}.`,
      "",
      `«${t.title}»`,
      ...(t.book ? [`Книжка: «${t.book.title}»${t.book.author ? `, ${t.book.author}` : ""}`] : []),
      "",
      ...(t.spoiler ? ["У темі можуть бути спойлери, тож текст тут не показуємо."] : [cut]),
      "",
      `Долучитися до обговорення: ${this.site}${t.href}`,
      "",
      "—",
      `Не надсилати листів про нові теми Клубу: ${off}`,
      `Усі листи: ${this.site}/settings/mail`,
    ].join("\n");
    const { mailLinks } = require("./admin");
    const html = withHtml ? mailLinks(this.html(t, cut, off), this.site, "club-topic", true) : "";
    return { to: reader.email, subject: `Клуб Chytai: ${t.title}`, text: mailLinks(body, this.site, "club-topic"), ...(html ? { html } : {}), headers: { "List-Unsubscribe": `<${off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }

  // The same letter in the Friday letter's look (digest.js): paper background, serif titles, the book's cover.
  html(t, cut, off) {
    const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const site = this.site;
    const href = `${site}${t.href}`;
    const cover = t.book?.cover ? `<img src="${esc(t.book.cover.startsWith("/") ? site + t.book.cover : t.book.cover)}" width="44" height="64" alt="" style="width:44px;height:64px;object-fit:cover;border-radius:3px;display:block;background:#ded8cb">` : "";
    const book = t.book ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:18px 0 4px"><tr>${cover ? `<td style="vertical-align:top;width:44px">${cover}</td>` : ""}<td style="vertical-align:middle;padding-left:${cover ? 14 : 0}px"><a href="${esc(site + t.book.href)}" style="font-family:'Source Serif 4',Georgia,serif;font-size:16px;color:#1b1a17;text-decoration:none">«${esc(t.book.title)}»</a>${t.book.author ? `<div style="font-size:13px;color:#6b675f;margin-top:3px">${esc(t.book.author)}</div>` : ""}</td></tr></table>` : "";
    const body = t.spoiler ? `<p style="font-size:15px;line-height:1.5;color:#6b675f;margin:18px 0 0">У темі можуть бути спойлери, тож текст тут не показуємо.</p>` : cut.split(/\n{2,}/).map((p) => `<p style="font-family:'Source Serif 4',Georgia,serif;font-size:16px;line-height:1.55;color:#3d3a33;margin:16px 0 0">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(t.title)}</title></head>
<body style="margin:0;background:#f7f4ee;color:#1b1a17;font-family:Onest,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="max-width:560px;margin:0 auto;padding:32px 20px 40px">
  <div style="font-weight:600;font-size:15px"><a href="${site}" style="color:#1b1a17;text-decoration:none">Chytai</a> <span style="color:#6b675f;font-weight:400;margin-left:10px">Клуб</span></div>
  <div style="margin-top:24px;font-size:13px;color:#6b675f">Нова тема в Клубі Chytai від <b style="color:#1b1a17;font-weight:500">${esc(t.reader.name)}</b></div>
  <h1 style="font-family:'Source Serif 4',Georgia,serif;font-weight:500;font-size:26px;line-height:1.25;margin:8px 0 0"><a href="${esc(href)}" style="color:#1b1a17;text-decoration:none">${esc(t.title)}</a></h1>
  ${book}
  ${body}
  <div style="margin:26px 0 0"><a href="${esc(href)}" style="display:inline-block;background:#266741;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:11px 20px;border-radius:999px">Долучитися до обговорення</a></div>
  <div style="border-top:1px solid #1b1a17;margin-top:36px;padding-top:14px;font-size:12px;line-height:1.6;color:#6b675f">
    Ви отримуєте ці листи як читач chytai.org.ua<br>
    <a href="${esc(off)}" style="color:#6b675f">Не надсилати листів про нові теми</a> · <a href="${site}/settings/mail" style="color:#6b675f">Налаштування</a> · <a href="${site}" style="color:#6b675f">chytai.org.ua</a>
  </div>
</div></body></html>`;
  }

  // While ON is false: each queued topic's letter, once, to the owner alone.
  async preview() {
    const owner = this.auth.reader(this.ownerId);
    if (!owner?.email) return "немає пошти власника";
    for (const q of this.store.db.prepare("SELECT topic FROM club_announce WHERE sent IS NULL ORDER BY queued").all()) {
      const key = `clubmail:preview2:${q.topic}`;
      const t = this.club.topic(q.topic);
      if (!t || this.store.db.get(key)) continue;
      this.store.db.set(key, new Date().toISOString());
      // Both looks, for Max to pick (2026-11-04).
      const plain = this.letter(t, owner, { withHtml: false });
      const fancy = this.letter(t, owner, { withHtml: true });
      await this.auth.sendBatch([{ ...plain, subject: `[текст] ${plain.subject}` }, { ...fancy, subject: `[як дайджест] ${fancy.subject}` }]);
      this.log(`club topic mail preview: «${t.title}» → owner (${this.recipients(t).length} would get it)`);
    }
    return "лише власнику";
  }

  // Sends the oldest queued topic if it is time. `force` skips the hours and the daily gap (owner test).
  async run({ now = new Date(), force = false } = {}) {
    const db = this.store.db;
    if (!ON) return this.preview();
    const h = Number(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "numeric", hour12: false })) % 24;
    if (!force && (h < HOURS[0] || h >= HOURS[1])) return "не та година";
    const last = db.prepare("SELECT MAX(sent) AS s FROM club_announce WHERE sent IS NOT NULL AND sent <> 'before'").get().s;
    if (!force && last && now - Date.parse(last) < GAP) return "сьогодні вже був лист";
    for (const q of db.prepare("SELECT topic FROM club_announce WHERE sent IS NULL ORDER BY queued").all()) {
      const t = this.club.topic(q.topic);
      // Deleted, or no answer from anyone else any more: nothing to say.
      if (!t || !this.club.posts(t.id).some((p) => p.reader.id !== t.reader.id)) {
        db.prepare("UPDATE club_announce SET sent = 'skipped', n = 0 WHERE topic = ?").run(q.topic);
        continue;
      }
      // Taken by this run alone.
      if (!db.prepare("UPDATE club_announce SET sent = ? WHERE topic = ? AND sent IS NULL").run(now.toISOString(), t.id).changes) continue;
      const to = this.recipients(t);
      let n = 0;
      for (let i = 0; i < to.length; i += BATCH) {
        const part = to.slice(i, i + BATCH);
        try {
          await this.auth.sendBatch(part.map((r) => this.letter(t, r)));
          n += part.length;
        } catch (e) {
          this.log(`club topic mail «${t.title}»: ${e.message}`);
        }
      }
      db.prepare("UPDATE club_announce SET n = ? WHERE topic = ?").run(n, t.id);
      this.log(`club topic mail: «${t.title}» → ${n} readers`);
      return `«${t.title}»: ${n}`;
    }
    return "черга порожня";
  }
}

module.exports = { ClubMail };
