// Every letter the site sends, by kind, and every «не надсилати» (Max, 2026-11-08: e-mail is a retention channel,
// look at it as a whole). Only the kind, the reader (when the address is a reader's) and the day: no addresses,
// no subjects, no opens. Clicks come from «Звідки приходять» (arrivals with utm_campaign = the kind).
// Kept 90 days (storage hygiene), cleaned once a day by the first letter of the day.
const { dayOf, addDaysOf } = (() => {
  const pad = (n) => String(n).padStart(2, "0");
  const dayOf = (t) => {
    const d = t instanceof Date ? t : new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const addDaysOf = (day, n) => dayOf(new Date(new Date(`${day}T12:00:00`).getTime() + n * 86400000));
  return { dayOf, addDaysOf };
})();

const KEEP_DAYS = 90;
// The kind names are the letters' utm_campaign (admin.mailLinks), so sent and clicked meet in one row.
const KINDS = [
  ["welcome", "Вітальний"],
  ["newbie", "Новачку, 2-й день"],
  ["digest", "П'ятничний дайджест"],
  ["want", "«Хочу» з'явилась"],
  ["club-topic", "Нова тема в Клубі"],
  ["club", "Відповідь у темі Клубу"],
  ["mention", "Згадка в Клубі"],
  ["follow", "Хтось стежить"],
  ["chat", "Чат"],
  ["code", "Код входу"],
  ["report", "Звіт видавцю"],
  ["owner", "Сповіщення власнику"],
];
const NAMES = Object.fromEntries(KINDS);
// Letters nobody asked for at that moment: at most CAP of them a reader a day, and none but the digest on Fridays.
const OPTIONAL = ["digest", "want", "club-topic", "newbie"];
const CAP = 2;

class MailLog {
  constructor(db) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS mail_log (day TEXT NOT NULL, kind TEXT NOT NULL, reader TEXT)");
    db.exec("CREATE INDEX IF NOT EXISTS mail_log_day ON mail_log (day, kind)");
    db.exec("CREATE INDEX IF NOT EXISTS mail_log_reader ON mail_log (reader, day)");
    db.exec("CREATE TABLE IF NOT EXISTS mail_switch (day TEXT NOT NULL, kind TEXT NOT NULL, reader TEXT NOT NULL, \"on\" INTEGER NOT NULL)");
    this.cleaned = "";
  }
  // Letters accepted by Resend: kind, and the readers they went to (null for an address that is no reader's).
  sent(kind, readers) {
    const day = dayOf(new Date());
    const add = this.db.prepare("INSERT INTO mail_log (day, kind, reader) VALUES (?, ?, ?)");
    this.db.tx(() => {
      for (const r of readers) add.run(day, kind || "other", r || null);
    });
    if (this.cleaned !== day) {
      this.cleaned = day;
      const old = addDaysOf(day, -KEEP_DAYS);
      this.db.prepare("DELETE FROM mail_log WHERE day < ?").run(old);
      this.db.prepare("DELETE FROM mail_switch WHERE day < ?").run(old);
    }
  }
  // A reader turned a kind of letter off (or back on), from a letter's link or the settings. Only real changes.
  switched(kind, reader, was, on) {
    if (!reader || !!was === !!on) return;
    this.db.prepare("INSERT INTO mail_switch (day, kind, reader, \"on\") VALUES (?, ?, ?, ?)").run(dayOf(new Date()), kind, reader, on ? 1 : 0);
  }
  // May this reader get one more optional letter today?
  room(reader, now = new Date()) {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM mail_log WHERE reader = ? AND day = ? AND kind IN (${OPTIONAL.map(() => "?").join(",")})`).get(reader, dayOf(now), ...OPTIONAL).n;
    return n < CAP;
  }
  // The «Листи» block's rows for the last `days` days: sent, readers, came back to the site, switched off.
  stats(days = 7, now = new Date()) {
    const since = addDaysOf(dayOf(now), -(days - 1));
    const sent = this.db.prepare("SELECT kind, COUNT(*) AS n, COUNT(DISTINCT reader) AS readers FROM mail_log WHERE day >= ? GROUP BY kind").all(since);
    const off = this.db.prepare("SELECT kind, SUM(\"on\" = 0) AS off, SUM(\"on\" = 1) AS back FROM mail_switch WHERE day >= ? GROUP BY kind").all(since);
    let clicks = [];
    try {
      clicks = this.db.prepare("SELECT ref, SUM(visits) AS n FROM arrivals WHERE day >= ? AND source = 'Пошта' AND ref LIKE 'кампанія: %' GROUP BY ref").all(since);
    } catch {}
    const since0 = this.db.prepare("SELECT MIN(day) AS d FROM mail_log").get()?.d || null;
    const rows = new Map();
    const row = (kind) => rows.get(kind) || (rows.set(kind, { kind, name: NAMES[kind] || kind, sent: 0, readers: 0, clicks: 0, off: 0, back: 0 }), rows.get(kind));
    for (const s of sent) Object.assign(row(s.kind), { sent: s.n, readers: s.readers });
    for (const o of off) Object.assign(row(o.kind), { off: o.off || 0, back: o.back || 0 });
    for (const c of clicks) row(c.ref.replace(/^кампанія: /, "")).clicks = c.n;
    const order = KINDS.map(([k]) => k);
    const list = [...rows.values()].sort((a, b) => (order.indexOf(a.kind) + 1 || 99) - (order.indexOf(b.kind) + 1 || 99));
    return { since: since0, days, rows: list };
  }
}

module.exports = { MailLog, KINDS, OPTIONAL, CAP };
