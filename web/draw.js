// The weekly draw (Max, 2026-10-28: «кожен тиждень розіграємо сертифікат 500 гривень на Якабу серед тих, хто
// поставив оцінку хоча б одній книжці»). Plan: the «Щотижневий розіграш» doc. A week runs Friday 00:00 to
// Thursday 23:59 Kyiv, so the Friday 9:00 letter can name the winner; the first week starts on START (a
// Monday) and is shorter. A reader takes part after pressing «Беру участь» (readers.draw, which is also the
// agreement to the rules) and rating at least one book that week (the `rated` log: entries.updated moves on
// any change). One chance per person however many books: more chances for more stars would bring stars for
// unread books. Not counted: the owner, throwaway mail, a second account on the same mailbox (dots and
// +tags in Gmail), a book the reader typed in by hand that nobody else has. Who wins is picked from the
// frozen list and a public random number (drand), so anyone can check it; that part comes with the admin tool.
const START = process.env.DRAW_START || "2026-11-02"; // Max may move it a week or two («будемо по ходу дивитись»)
const DRAW_HOUR = "08:05"; // Friday, Kyiv
const THROWAWAY = new Set(["mailinator.com", "10minutemail.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "yopmail.com", "temp-mail.org", "tempmail.com", "trashmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "mohmal.com", "emailondeck.com", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "tempr.email", "discard.email", "mailnesia.com", "spamgourmet.com", "1secmail.com", "tmpmail.org", "minuteinbox.com", "moakt.com", "emailfake.com", "inboxkitten.com"]);

const DAY = 86400000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sunday … 5 Friday
const dayKyiv = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
// Kyiv's offset from UTC at that moment, in minutes (+120 in winter, +180 in summer).
const offset = (d) => {
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv", timeZoneName: "longOffset" }));
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
// The UTC moment of a Kyiv wall-clock time.
const kyivTime = (day, time = "00:00") => {
  const guess = new Date(`${day}T${time}:00Z`);
  return new Date(guess.getTime() - offset(guess) * 60000);
};

// The week a moment falls in: { from, to } as Kyiv days (to = the Thursday), the UTC bounds, and when its
// draw is. Before START it is the first week, marked upcoming.
function weekOf(now = new Date()) {
  let day = dayKyiv(now);
  const upcoming = day < START;
  if (upcoming) day = START;
  let from = addDays(day, -((weekday(day) - 5 + 7) % 7));
  if (from < START) from = START;
  const to = addDays(from, (4 - weekday(from) + 7) % 7);
  const drawDay = addDays(to, 1);
  return { from, to, upcoming, start: kyivTime(from), end: kyivTime(addDays(to, 1)), drawAt: kyivTime(drawDay, DRAW_HOUR), drawDay };
}

// One mailbox, one participant: Gmail ignores dots and anything after «+», most others the «+» part.
function mailbox(email) {
  let [user, host] = String(email || "").toLowerCase().trim().split("@");
  if (!host) return "";
  if (host === "googlemail.com") host = "gmail.com";
  user = user.split("+")[0];
  if (host === "gmail.com") user = user.replace(/\./g, "");
  return `${user}@${host}`;
}
const throwaway = (email) => THROWAWAY.has(String(email || "").toLowerCase().split("@")[1] || "");

class Draw {
  constructor({ store, auth, ownerId = "owner" }) {
    this.store = store;
    this.auth = auth;
    this.ownerId = ownerId;
    this.db = store.db;
  }

  joined(readerId) {
    return !!this.auth.reader(readerId)?.draw;
  }
  setJoined(readerId, on) {
    this.db.prepare("UPDATE readers SET draw = ? WHERE id = ?").run(on ? new Date().toISOString() : null, readerId);
  }

  // Everyone who rated a book in the week, with why they are in or out: [{ reader, books, joined, out }],
  // `out` = "" when they take part. Out: not joined, the owner, no mail, throwaway mail, a second account on
  // one mailbox (the first to join stays), only hand-typed books nobody else has.
  entrants(week = weekOf()) {
    const rows = this.db
      .prepare("SELECT r.reader, r.book, MAX(r.at) AS at FROM rated r JOIN entries e ON e.reader = r.reader AND e.book = r.book AND e.rating IS NOT NULL WHERE r.at >= ? AND r.at < ? GROUP BY r.reader, r.book")
      .all(week.start.toISOString(), week.end.toISOString());
    const by = new Map();
    for (const r of rows) {
      const id = this.store.canonical(r.book);
      if (!this.store.book(id)) continue;
      if (this.store.lib.books[id]?.source === "manual" && ![...this.store.entries].some(([reader, e]) => reader !== r.reader && e[id])) continue;
      if (!by.has(r.reader)) by.set(r.reader, { reader: this.auth.reader(r.reader), books: [] });
      by.get(r.reader).books.push({ id, at: r.at });
    }
    const out = [...by.values()].filter((x) => x.reader).sort((a, b) => (a.reader.draw || "~").localeCompare(b.reader.draw || "~"));
    const seen = new Set();
    for (const x of out) {
      const r = x.reader;
      const box = mailbox(r.email);
      x.joined = !!r.draw;
      x.out = r.id === this.ownerId ? "owner" : !r.draw ? "not joined" : !r.email ? "no mail" : throwaway(r.email) ? "throwaway mail" : seen.has(box) ? "same mailbox" : "";
      if (!x.out) seen.add(box);
      x.books.sort((a, b) => b.at.localeCompare(a.at));
    }
    return out;
  }
  participants(week = weekOf()) {
    return this.entrants(week).filter((x) => !x.out);
  }

  // What the draw page shows the reader: in this week's draw, joined with no rating yet, or not joined.
  status(user, week = weekOf()) {
    if (!user) return { state: "guest" };
    const r = this.auth.reader(user.id);
    if (!r?.draw) return { state: "out" };
    const me = this.entrants(week).find((x) => x.reader.id === user.id);
    if (me && !me.out) return { state: "in", book: this.store.book(me.books[0].id) };
    if (me?.out === "throwaway mail" || me?.out === "same mailbox" || me?.out === "no mail") return { state: "mail", why: me.out };
    return { state: "joined" };
  }

  // Past weeks, newest first (filled by the draw itself, with the admin tool).
  history() {
    return this.db.prepare("SELECT week, data FROM draws ORDER BY week DESC").all().map((r) => ({ week: r.week, ...JSON.parse(r.data) }));
  }
}

module.exports = { Draw, weekOf, mailbox, throwaway, kyivTime, START };
