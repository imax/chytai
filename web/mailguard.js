// Addresses mail does not reach (risk review 2026-11-05). Sign-in codes and every other letter go through one
// Resend account; letters that bounce or that readers mark as spam hurt its standing, and a paused account means
// nobody can sign in. Resend tells us about both through a webhook (Resend → Webhooks → endpoint
// https://chytai.org.ua/api/resend/webhook, events email.bounced and email.complained; its signing secret is the
// Fly secret RESEND_WEBHOOK_SECRET of chytai-web). Without the secret the webhook answers 404 and nothing changes.
//
// - bounced (the receiving server said the address does not exist): no letters at all for 90 days, and the sign-in
//   page says the address does not take mail;
// - complained (marked as spam): no letters except sign-in codes the reader asks for themselves.
// Telegram hears about every complaint and about a day with 10+ bounces (someone typing made-up addresses).
// Addresses never go to Telegram or /admin: a username when the address is a reader's, else just a count.
const crypto = require("crypto");
const telegram = require("./telegram");

const SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const BOUNCE_DAYS = 90;
const BOUNCE_ALERT = 10;

class MailGuard {
  constructor(db, { usernameOf = () => null } = {}) {
    this.db = db;
    this.usernameOf = usernameOf;
    db.exec("CREATE TABLE IF NOT EXISTS mail_blocked (email TEXT PRIMARY KEY, why TEXT NOT NULL, at TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS mail_events (at TEXT NOT NULL, why TEXT NOT NULL)");
  }
  on() {
    return !!SECRET;
  }
  // "bounce" | "complaint" | null for an address.
  blocked(email) {
    const r = this.db.prepare("SELECT why, at FROM mail_blocked WHERE email = ?").get(String(email || "").trim().toLowerCase());
    if (!r) return null;
    if (r.why === "bounce" && Date.parse(r.at) < Date.now() - BOUNCE_DAYS * 86400000) return null;
    return r.why;
  }
  // May this letter go? A sign-in code (code: true) goes to an address marked as spam, never to one that bounced.
  allowed(email, { code = false } = {}) {
    const why = this.blocked(email);
    return !why || (code && why === "complaint");
  }

  // Svix signing, as Resend does it: HMAC-SHA256 over "id.timestamp.body" with the secret's base64 part.
  verify(headers, raw) {
    if (!SECRET) return false;
    const id = headers["svix-id"];
    const ts = headers["svix-timestamp"];
    const sigs = String(headers["svix-signature"] || "").split(" ").map((s) => s.split(",")[1]).filter(Boolean);
    if (!id || !ts || !sigs.length || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const want = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
    return sigs.some((s) => {
      const got = Buffer.from(s, "base64");
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    });
  }

  // One webhook event ({ type, data: { to: [...], bounce: { type } } }).
  event(e) {
    const why = e?.type === "email.bounced" ? "bounce" : e?.type === "email.complained" ? "complaint" : null;
    if (!why) return;
    // A bounce that may pass (a full mailbox, a server down for a while) blocks nothing.
    if (why === "bounce" && /transient/i.test(e.data?.bounce?.type || "")) return;
    const now = new Date().toISOString();
    for (const to of [].concat(e.data?.to || [])) {
      const email = String(to).trim().toLowerCase();
      if (!email.includes("@")) continue;
      // A complaint stays a complaint even if the address bounces later; a bounce turns into a complaint.
      const had = this.blocked(email);
      if (!(had === "complaint" && why === "bounce")) this.db.prepare("INSERT OR REPLACE INTO mail_blocked (email, why, at) VALUES (?, ?, ?)").run(email, why, now);
      this.db.prepare("INSERT INTO mail_events (at, why) VALUES (?, ?)").run(now, why);
      if (why === "complaint") {
        const u = this.usernameOf(email);
        telegram.send(`Лист Chytai позначили як спам${u ? `: https://chytai.org.ua/@${u}` : " (не читач сайту)"}.\nЦій адресі більше не пишемо, крім кодів входу.`);
      }
    }
    this.db.prepare("DELETE FROM mail_events WHERE at < ?").run(new Date(Date.now() - 90 * 86400000).toISOString());
    const day = this.count("bounce", 1);
    if (why === "bounce" && day >= BOUNCE_ALERT) telegram.sendOnce("mail-bounces", 24, `За добу ${day} листів не дійшли: адреси не існують. Можливо, хтось вписує вигадані адреси на сторінці входу. Таким адресам більше не пишемо.\n\nhttps://chytai.org.ua/admin`);
  }
  count(why, days) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM mail_events WHERE why = ? AND at >= ?").get(why, new Date(Date.now() - days * 86400000).toISOString()).n;
  }
  // The row for /admin's status block: [ok, good text, bad text].
  health() {
    if (!SECRET) return [false, "", "Пошта: Resend не повідомляє сайт про недоставлені листи. Потрібен вебхук: README, розділ «Пошта»."];
    const b = this.count("bounce", 7);
    const c = this.count("complaint", 7);
    return [c === 0 && this.count("bounce", 1) < BOUNCE_ALERT, `Пошта: ${c} скарг, ${b} bounce.`, `Пошта: за тиждень недоставлених ${b}, скарг на спам ${c}. Таким адресам більше не пишемо.`];
  }
}

module.exports = { MailGuard };
