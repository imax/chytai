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

class ClubMail {
  constructor({ store, auth, club, digest, site, log = console.log }) {
    Object.assign(this, { store, auth, club, digest, site, log });
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
    return this.auth.readers().filter((r) => r.email && r.digest !== 0 && r.topic_mail !== 0 && !inside.has(r.id));
  }

  // The letter for a reader: { to, subject, text, headers }.
  letter(topic, reader) {
    const off = this.offUrl(reader.id);
    const t = topic;
    const text = String(t.text || "").trim().replace(/\n{3,}/g, "\n\n");
    const cut = text.length > 700 ? `${text.slice(0, 700).replace(/\s+\S*$/, "")}…` : text;
    const body = [
      `Нова тема в Клубі Chytai від ${t.reader.name}. Там уже відповідають.`,
      "",
      `«${t.title}»`,
      ...(t.book ? [`Книжка: «${t.book.title}»${t.book.author ? `, ${t.book.author}` : ""}`] : []),
      "",
      ...(t.spoiler ? ["У темі можуть бути спойлери, тож текст тут не показуємо."] : [cut]),
      "",
      `Прочитати й відповісти: ${this.site}${t.href}`,
      "",
      "—",
      `Не надсилати листів про нові теми Клубу: ${off}`,
      `Усі листи: ${this.site}/settings/mail`,
    ].join("\n");
    const { mailLinks } = require("./admin");
    return { to: reader.email, subject: `Клуб Chytai: ${t.title}`, text: mailLinks(body, this.site, "club-topic"), headers: { "List-Unsubscribe": `<${off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }

  // Sends the oldest queued topic if it is time. `force` skips the hours and the daily gap (owner test).
  async run({ now = new Date(), force = false } = {}) {
    const db = this.store.db;
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
