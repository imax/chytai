// Accounts for the web platform (Max, 2026-10-20): a reader is one person, signed in by a code sent to
// their e-mail, no passwords. Each reader has a public page /@<username> and a display name.
//   - readers and sessions live in the database (db.js); the session cookie carries a random token
//     whose hash is the sessions row, so a leaked database does not sign anyone in.
//   - sign-in codes are six digits, good for ten minutes, five tries per address; a few codes per
//     address and per IP an hour. They live in the database (login_codes, keyed by a hash of the
//     address, no e-mail stored), not in memory: a deploy or restart in those ten minutes used to lose
//     the code, and the reader got «Код застарів» a minute after the letter (2026-10-23). Every code
//     still within its ten minutes works, so an earlier letter is fine after asking for a new one.
//     The ticket after a code for a new address is signed, not stored, for the same reason. Without RESEND_API_KEY the code is printed to the log instead of
//     mailed (local runs and the first days on prod).
//   - the owner (reader id "owner", Max) existed before accounts: WEB_LOGIN_TOKEN's magic link still
//     signs in as the owner, and the cookie it set before accounts keeps working, so nothing logs him out.
const crypto = require("crypto");

const CODE_TTL = 10 * 60 * 1000;
const CODE_TRIES = 5;
const PER_EMAIL_HOUR = 5;
const PER_IP_HOUR = 20;
const SESSION_DAYS = 365;

// Usernames: Latin lowercase, digits, dot or underscore, 3–30 characters, not starting or ending with
// punctuation. Words that are, or could become, site sections are kept out of reach.
const USERNAME = /^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])$/;
const RESERVED = new Set("admin administrator api app author authors book books chytai discovery help info login logout me mail news owner privacy reader readers root search settings shelf shelves signup support team www".split(" "));
const NOW_MAX = 1; // Max, 2026-10-22: «давай одну книжку»
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

class Auth {
  constructor(db, { ownerToken = "", from = "", resendKey = "", log = console.log } = {}) {
    this.db = db;
    this.ownerToken = ownerToken;
    this.legacySession = ownerToken ? sha(`chytai-web:${ownerToken}`) : null; // the cookie value before accounts
    this.from = from;
    this.resendKey = resendKey;
    this.log = log;
    this.sent = new Map(); // email or ip -> [timestamps]
    // Signs tickets (a verified e-mail that has no reader yet); kept in meta so restarts keep them valid.
    this.ticketKey = db.get("ticket_key") || (db.set("ticket_key", crypto.randomBytes(32).toString("hex")), db.get("ticket_key"));
    this.cache = new Map(); // session hash -> reader id
  }

  // ---- readers ----

  reader(id) {
    return (id && this.db.prepare("SELECT * FROM readers WHERE id = ?").get(id)) || null;
  }
  byUsername(u) {
    return (u && this.db.prepare("SELECT * FROM readers WHERE username = ?").get(String(u).toLowerCase())) || null;
  }
  byEmail(e) {
    return (e && this.db.prepare("SELECT * FROM readers WHERE email = ?").get(e)) || null;
  }
  readers() {
    return this.db.prepare("SELECT * FROM readers ORDER BY created").all();
  }

  // «Читаю зараз»: one book from the reader's shelf and the day it went up. Set by hand
  // only: a reader also reads on paper.
  nowOf(id) {
    try {
      const v = JSON.parse(this.reader(id)?.now || "null");
      if (v) return { books: Array.isArray(v.books) ? v.books : [], at: v.at || null };
    } catch {}
    return { books: [], at: null };
  }
  setNow(id, { books }) {
    const v = { books: books.slice(0, NOW_MAX), at: now() };
    this.db.prepare("UPDATE readers SET now = ? WHERE id = ?").run(v.books.length ? JSON.stringify(v) : null, id);
    return v;
  }

  // The owner's row, made on the first start with accounts; the name and username come from the env.
  ensureOwner({ id, name, username }) {
    if (this.reader(id)) return this.reader(id);
    this.db.prepare("INSERT INTO readers (id, email, username, name, created) VALUES (?, NULL, ?, ?, ?)").run(id, username, name, now());
    return this.reader(id);
  }

  checkUsername(u, selfId = null) {
    u = String(u || "").trim().toLowerCase();
    if (!USERNAME.test(u)) return { error: "Ім'я для адреси: 3–30 знаків, латинські літери, цифри, крапка чи підкреслення." };
    if (RESERVED.has(u)) return { error: "Це ім'я зайняте." };
    const other = this.byUsername(u);
    if (other && other.id !== selfId) return { error: "Це ім'я зайняте." };
    return { username: u };
  }
  checkName(n) {
    n = String(n || "").replace(/\s+/g, " ").trim();
    if (n.length < 1 || n.length > 60) return { error: "Потрібне ім'я, до 60 знаків." };
    return { name: n };
  }
  checkEmail(e) {
    e = String(e || "").trim().toLowerCase();
    if (!EMAIL.test(e) || e.length > 200) return { error: "Схоже, це не адреса пошти." };
    return { email: e };
  }

  // A username to offer a new reader: their name in Latin letters (store's translit), free.
  suggestUsername(name, slugify) {
    let base = slugify(name).replace(/-/g, ".").replace(/[^a-z0-9.]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "").slice(0, 24);
    if (base.length < 3) base = `chytach${base ? "." + base : ""}`;
    let u = base;
    for (let n = 2; !this.checkUsername(u).username; n++) u = `${base}${n}`;
    return u;
  }

  createReader({ email, username, name }) {
    const id = crypto.randomBytes(8).toString("hex");
    this.db.prepare("INSERT INTO readers (id, email, username, name, created, seen) VALUES (?, ?, ?, ?, ?, ?)").run(id, email, username, name, now(), now());
    return this.reader(id);
  }
  updateReader(id, patch) {
    const r = this.reader(id);
    if (!r) return null;
    const next = { ...r, ...patch };
    this.db.prepare("UPDATE readers SET email = ?, username = ?, name = ? WHERE id = ?").run(next.email, next.username, next.name, id);
    return this.reader(id);
  }
  // Everything of theirs goes: entries, subscriptions, sessions, follows both ways, the row.
  deleteReader(id) {
    this.db.tx(() => {
      for (const t of ["entries", "subscriptions", "sessions", "follows", "follow_mails", "visits", "digest_log", "want_mail"]) this.db.prepare(`DELETE FROM ${t} WHERE reader = ?`).run(id);
      for (const t of ["follows", "follow_mails"]) this.db.prepare(`DELETE FROM ${t} WHERE target = ?`).run(id);
      this.db.prepare("DELETE FROM readers WHERE id = ?").run(id);
    });
    for (const [h, r] of this.cache) if (r === id) this.cache.delete(h);
  }

  // ---- following (2026-10-20, from the design): «Стежити» on another reader's page ----
  // Whom a reader follows picks whose activity they see first; the followed reader gets one letter.

  follows(readerId, targetId) {
    return !!(readerId && targetId && this.db.prepare("SELECT 1 FROM follows WHERE reader = ? AND target = ?").get(readerId, targetId));
  }
  // Ids of the readers this one follows.
  following(readerId) {
    return readerId ? this.db.prepare("SELECT target FROM follows WHERE reader = ? ORDER BY created").all(readerId).map((r) => r.target) : [];
  }
  // Ids of the readers who follow this one, newest first.
  followers(readerId) {
    return readerId ? this.db.prepare("SELECT reader FROM follows WHERE target = ? ORDER BY created DESC").all(readerId).map((r) => r.reader) : [];
  }
  // Follow or unfollow; returns the new state, or null when there is no such reader (or it is oneself).
  toggleFollow(readerId, targetId) {
    if (!this.reader(targetId) || targetId === readerId) return null;
    if (this.follows(readerId, targetId)) {
      this.db.prepare("DELETE FROM follows WHERE reader = ? AND target = ?").run(readerId, targetId);
      return false;
    }
    this.db.prepare("INSERT INTO follows (reader, target, created) VALUES (?, ?, ?)").run(readerId, targetId, now());
    return true;
  }

  // A letter «X тепер стежить за вашою полицею» goes once per pair, the first time, if the reader
  // has not switched it off (readers.follow_mail). Returns true when this follow deserves one.
  followMailDue(readerId, targetId) {
    const t = this.reader(targetId);
    if (!t?.email || t.follow_mail === 0) return false;
    if (this.db.prepare("SELECT 1 FROM follow_mails WHERE reader = ? AND target = ?").get(readerId, targetId)) return false;
    this.db.prepare("INSERT INTO follow_mails (reader, target, sent) VALUES (?, ?, ?)").run(readerId, targetId, now());
    return true;
  }
  followMailEnabled(readerId) {
    const r = this.reader(readerId);
    return !!r && r.follow_mail !== 0;
  }
  setIndexed(readerId, on) {
    this.db.prepare("UPDATE readers SET noindex = ? WHERE id = ?").run(on ? 0 : 1, readerId);
  }
  setOriginals(readerId, on) {
    this.db.prepare("UPDATE readers SET originals = ? WHERE id = ?").run(on ? 1 : 0, readerId);
  }
  setFollowMail(readerId, on) {
    this.db.prepare("UPDATE readers SET follow_mail = ? WHERE id = ?").run(on ? 1 : 0, readerId);
  }

  // ---- sessions ----

  // A new session for the reader: the cookie value to set.
  signIn(readerId) {
    const token = crypto.randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO sessions (id, reader, created, seen) VALUES (?, ?, ?, ?)").run(sha(token), readerId, now(), now());
    this.db.prepare("UPDATE readers SET seen = ? WHERE id = ?").run(now(), readerId);
    return token;
  }
  // The reader behind a cookie value, or null.
  readerOf(token, ownerId) {
    if (!token) return null;
    if (this.legacySession && token === this.legacySession) return this.reader(ownerId);
    const h = sha(token);
    let id = this.cache.get(h);
    if (!id) {
      const row = this.db.prepare("SELECT reader FROM sessions WHERE id = ?").get(h);
      if (!row) return null;
      id = row.reader;
      this.cache.set(h, id);
      this.db.prepare("UPDATE sessions SET seen = ? WHERE id = ?").run(now(), h);
    }
    const r = this.reader(id);
    if (!r) this.cache.delete(h);
    return r;
  }
  signOut(token) {
    if (!token) return;
    const h = sha(token);
    this.cache.delete(h);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(h);
  }
  // Leave the other devices signed out (after a changed e-mail, or on request).
  signOutEverywhere(readerId) {
    this.db.prepare("DELETE FROM sessions WHERE reader = ?").run(readerId);
    for (const [h, r] of this.cache) if (r === readerId) this.cache.delete(h);
  }
  cookie(token, { secure, clear = false } = {}) {
    return `chytai_web=${clear ? "" : token}; Path=/; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  // ---- sign-in codes ----

  tooMany(key, limit) {
    const t = Date.now();
    const list = (this.sent.get(key) || []).filter((x) => t - x < 3600 * 1000);
    this.sent.set(key, list);
    if (list.length >= limit) return true;
    list.push(t);
    return false;
  }

  // Make a code for the address and mail it. Returns { ok } or { error }.
  async sendCode(email, ip) {
    if (this.tooMany(`ip:${ip}`, PER_IP_HOUR) || this.tooMany(`email:${email}`, PER_EMAIL_HOUR)) return { error: "Забагато спроб. Спробуйте за годину." };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const hash = sha(`${email}:${code}`);
    this.db.prepare("DELETE FROM login_codes WHERE expires < ?").run(Date.now());
    this.db.prepare("INSERT INTO login_codes (key, hash, expires) VALUES (?, ?, ?)").run(sha(`code:${email}`), hash, Date.now() + CODE_TTL);
    try {
      await this.mail(email, code);
    } catch (e) {
      this.log(`mail to ${email} failed: ${e.message}`);
      this.db.prepare("DELETE FROM login_codes WHERE hash = ?").run(hash);
      return { error: "Не вдалося надіслати лист. Спробуйте ще раз трохи згодом." };
    }
    return { ok: true };
  }

  // Check the code. Returns { reader } for a known address, { ticket } for a new one, or { error }.
  verify(email, code) {
    const key = sha(`code:${email}`);
    const rows = this.db.prepare("SELECT hash, tries FROM login_codes WHERE key = ? AND expires >= ?").all(key, Date.now());
    if (!rows.length) return { error: "Код застарів. Запросіть новий." };
    if (rows.every((r) => r.tries >= CODE_TRIES)) return (this.db.prepare("DELETE FROM login_codes WHERE key = ?").run(key), { error: "Забагато спроб. Запросіть новий код." });
    this.db.prepare("UPDATE login_codes SET tries = tries + 1 WHERE key = ?").run(key);
    rows.splice(0, rows.length, ...rows.filter((r) => r.tries < CODE_TRIES));
    const hash = sha(`${email}:${String(code).replace(/\D/g, "")}`);
    if (!rows.some((r) => r.hash === hash)) return { error: "Код не підходить." };
    this.db.prepare("DELETE FROM login_codes WHERE key = ?").run(key);
    const reader = this.byEmail(email);
    if (reader) return { reader };
    const body = Buffer.from(JSON.stringify({ email, expires: Date.now() + CODE_TTL })).toString("base64url");
    return { ticket: `${body}.${this.signTicket(body)}` };
  }
  signTicket(body) {
    return crypto.createHmac("sha256", this.ticketKey).update(body).digest("base64url");
  }
  // The e-mail a ticket stands for, while it lasts.
  ticketEmail(ticket) {
    const [body, sig] = String(ticket || "").split(".");
    if (!body || !sig) return null;
    const want = Buffer.from(this.signTicket(body));
    if (want.length !== Buffer.from(sig).length || !crypto.timingSafeEqual(want, Buffer.from(sig))) return null;
    try {
      const t = JSON.parse(Buffer.from(body, "base64url").toString());
      return t.expires >= Date.now() ? t.email : null;
    } catch {
      return null;
    }
  }
  // Nothing to forget: once the reader exists, signup with the same ticket just signs them in.
  useTicket() {}

  async mail(email, code) {
    const subject = `${code} — код для входу в Chytai`;
    const text = `Ваш код для входу на chytai.org.ua: ${code}\n\nВін діє 10 хвилин. Якщо ви не просили код, просто не зважайте на цей лист.`;
    return this.send(email, subject, text);
  }

  // A letter through Resend (plain text, with an HTML version, extra headers and attachments
  // ([{ filename, content: base64 }]) when given); without the key it goes to the log instead.
  async send(to, subject, text, { html = "", headers = null, attachments = null } = {}) {
    if (!this.resendKey) {
      this.log(`[mail] no RESEND_API_KEY: to ${to}: ${subject}\n${text}`);
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject, text, ...(html ? { html } : {}), ...(headers ? { headers } : {}), ...(attachments ? { attachments } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  // Up to 100 letters in one Resend call ({ to, subject, text, html, headers } each), for the weekly letter.
  async sendBatch(letters) {
    if (!letters.length) return;
    if (!this.resendKey) {
      for (const l of letters) this.log(`[mail] no RESEND_API_KEY: to ${l.to}: ${l.subject}`);
      return;
    }
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(letters.map((l) => ({ from: this.from, to: [l.to], subject: l.subject, text: l.text, ...(l.html ? { html: l.html } : {}), ...(l.headers ? { headers: l.headers } : {}) }))),
    });
    if (!res.ok) throw new Error(`Resend batch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

module.exports = { NOW_MAX, Auth, USERNAME, RESERVED };
