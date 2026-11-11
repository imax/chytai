// Feature flags (Max, 2026-11-09, from Amp's talk: a change goes live behind a flag that only Max sees, he tries it on
// the real site, and then it is switched on for everyone; instead of screenshots and an OK before a deploy).
// Who sees a flagged thing:
//   off   nobody
//   owner Max only
//   test  Max and the test accounts (e-mail on test.invalid / test domains, auth.testAddress)
//   all   everyone
// They live in meta `flags` as JSON { name: { who, at, by, note } }; a flag that is not there is off. The web
// process keeps a copy for ten seconds, so a switch takes effect within that, with no deploy.
// A thread may set a flag to off / owner / test itself (POST /agent/flags); `all` only Max, on /admin/jobs.
const WHO = ["off", "owner", "test", "all"];
const LABEL = { off: "вимкнено", owner: "лише Макс", test: "Макс і тестові", all: "усі" };

// The flags the code knows about, with a few words for /admin. A new flag is added here.
const KNOWN = {
  ask: "Що почитати далі? Поле на /ask (самі відповіді за посиланням бачать усі)",
  chat: "Чат між читачами (/chat, кнопка на полиці)",
  "list-progress": "Скільки книжок зі списку ви прочитали",
  "reader-books": "Книжки, завантажені в Читалку, самі з’являються в каталозі",
};

class Flags {
  constructor(db, { testAddress }) {
    this.db = db;
    this.testAddress = testAddress;
    this.cache = null;
    this.at = 0;
  }
  all() {
    if (!this.cache || Date.now() - this.at > 10000) {
      try {
        this.cache = JSON.parse(this.db.get("flags") || "{}");
      } catch {
        this.cache = {};
      }
      this.at = Date.now();
    }
    return this.cache;
  }
  who(name) {
    return this.all()[name]?.who || "off";
  }
  // user: req.user (pub()) or null.
  on(name, user) {
    const w = this.who(name);
    if (w === "all") return true;
    if (!user) return false;
    if (user.owner) return w !== "off";
    return w === "test" && !!user.email && this.testAddress(user.email);
  }
  set(name, who, by, note = "") {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error("bad flag name");
    if (!WHO.includes(who)) throw new Error(`who: ${WHO.join(" | ")}`);
    const all = { ...this.all() };
    all[name] = { who, at: new Date().toISOString(), by, note: String(note || all[name]?.note || "").slice(0, 200) };
    this.db.set("flags", JSON.stringify(all));
    this.cache = all;
    this.at = Date.now();
    console.log(`[flags] ${name} → ${who} (${by})`);
    return all[name];
  }
  // For /admin and /agent: every known flag and every set one.
  list() {
    const all = this.all();
    const names = [...new Set([...Object.keys(KNOWN), ...Object.keys(all)])];
    return names.map((name) => ({ name, what: KNOWN[name] || all[name]?.note || "", who: all[name]?.who || "off", label: LABEL[all[name]?.who || "off"], at: all[name]?.at || "", by: all[name]?.by || "" }));
  }
}

module.exports = { Flags, WHO, LABEL };
