// Messages to the owner in Telegram (Max, 2026-11-04: «я імейлом майже не користуюсь … подумати про альтернативний
// канал зв'язку зі мною»). One private bot: TELEGRAM_BOT_TOKEN in Fly secrets of chytai-web. The chat it writes to
// is TELEGRAM_CHAT_ID, or the first chat that sent the bot /start (kept in meta `telegram:chat`); after that the
// bot answers nobody else. Without a token nothing is sent and nothing breaks.
//
// Sent: everything notifyOwner mails (readers' lists, comments, books…), a wave of sign-ups, a background job that
// failed, the reader app not answering (and answering again). Never readers' e-mail addresses.
//
// More chats (Max, 2026-11-16: his second account on Android): someone else's /start sends the linked chat
// «Просить доступ» with «Дозволити» / «Ні»; once allowed, every message goes to them too (meta `telegram:extra`,
// [{ id, name }]). /who in the linked chat lists them with «Забрати»; /off in theirs stops it. Only the linked chat
// presses buttons. The reader gets the whole list from the site (`chats()`).
//
// Bug reports (Max, 2026-11-18): anything else the linked chat or an allowed one writes (text, a screenshot, a voice,
// a forward) goes to the handler set with onMessage (bugbox.js), which keeps it for the morning review.
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `${process.env.TELEGRAM_API || "https://api.telegram.org"}/bot${TOKEN}`; // TELEGRAM_API: a stand-in for tests
let db = null;

const on = () => !!TOKEN;
// The webhook's path carries a secret made from the token, so nobody else can post updates to it.
const hookPath = () => (TOKEN ? `/api/telegram/${crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 32)}` : "");
const chat = () => process.env.TELEGRAM_CHAT_ID || db?.get("telegram:chat") || "";
const extra = () => {
  try {
    const l = JSON.parse(db?.get("telegram:extra") || "[]");
    return Array.isArray(l) ? l.filter((c) => c && /^\d{1,20}$/.test(String(c.id))) : [];
  } catch {
    return [];
  }
};
const setExtra = (l) => db.set("telegram:extra", JSON.stringify(l));
// Every chat a message goes to: the linked one first.
const chats = () => (chat() ? [chat(), ...extra().map((c) => String(c.id)).filter((id) => id !== chat())] : []);

function init(database) {
  db = database;
}
function call(method, body) {
  return fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.description || `HTTP ${r.status}`);
    return d.result;
  });
}
// Plain text, cut to Telegram's limit, with optional buttons under it ([[{ text, data }]]), to one chat or (no `to`)
// to every chat. Buttons go only to the linked chat: only it may press them. Never throws; true when any got it.
// `reply`: a message id in `to` to answer under.
function send(text, to = null, buttons = null, reply = 0) {
  if (!TOKEN) return Promise.resolve(false);
  text = String(text || "").trim();
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  const one = (id, withButtons) => {
    const markup = withButtons && buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {};
    const under = reply && to ? { reply_parameters: { message_id: +reply, allow_sending_without_reply: true } } : {};
    return call("sendMessage", { chat_id: id, text, disable_web_page_preview: true, ...markup, ...under })
      .then(() => true)
      .catch((e) => (console.error(`[telegram] ${id}: ${e.message}`), false));
  };
  if (to) return one(String(to), true);
  const all = chats();
  if (!all.length) return Promise.resolve(false);
  return Promise.all(all.map((id, i) => one(id, i === 0))).then((r) => r.some(Boolean));
}
// At most once per `hours` for one key (kept in the database, so the web and jobs processes and restarts agree).
function sendOnce(key, hours, text) {
  if (!TOKEN || !chat() || !db) return Promise.resolve(false);
  const k = `telegram:once:${key}`;
  const last = Date.parse(db.get(k) || "") || 0;
  if (Date.now() - last < hours * 3600000) return Promise.resolve(false);
  db.set(k, new Date().toISOString());
  return send(text);
}
// A file someone sent the bot (by its file_id) → Buffer. The Bot API gives files up to 20 MB.
async function file(fileId) {
  const f = await call("getFile", { file_id: fileId });
  if (!f?.file_path) throw new Error("no file_path");
  const base = (process.env.TELEGRAM_API || "https://api.telegram.org") + `/file/bot${TOKEN}/`;
  const r = await fetch(base + f.file_path, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`file: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
let onMsg = null;
const onMessage = (fn) => (onMsg = fn);
// /bugs: a handler's own commands (bugbox.js `command`), set with onCommand.
let onCmd = null;
const onCommand = (fn) => (onCmd = fn);

// The site tells Telegram where to post updates (on every start: cheap, and survives a changed address).
function setWebhook(site) {
  if (!TOKEN || !/^https:/.test(site)) return;
  call("setWebhook", { url: `${site}${hookPath()}`, allowed_updates: ["message", "callback_query"] })
    .then(() => console.log("[telegram] webhook set"))
    .catch((e) => console.error(`[telegram] webhook: ${e.message}`));
}
// A button under a message (e.g. «Сховати» under a new article): `prefix:arg` in its data goes to the handler of
// that prefix, which answers with a short line shown in Telegram. Only from the linked chat.
const actions = new Map();
const onAction = (prefix, fn) => actions.set(prefix, fn);
async function pressed(q) {
  const from = String(q.message?.chat?.id || q.from?.id || "");
  let answer = "Не вийшло.";
  if (from && from === chat()) {
    const [prefix, ...rest] = String(q.data || "").split(":");
    const fn = actions.get(prefix);
    try {
      if (fn) answer = (await fn(rest.join(":"))) || "Готово.";
    } catch (e) {
      answer = e.message;
    }
  }
  return call("answerCallbackQuery", { callback_query_id: q.id, text: answer.slice(0, 190) }).catch((e) => console.error(`[telegram] answer: ${e.message}`));
}
// Who wrote: «Ім'я Прізвище (@нік)».
const who = (f = {}) => [[f.first_name, f.last_name].filter(Boolean).join(" "), f.username ? `(@${f.username})` : ""].filter(Boolean).join(" ") || "без імені";
const HELLO = "Підключено. Сюди приходитимуть новини сайту Chytai: що створюють читачі, хвилі реєстрацій, збої.";

// Open requests: { id: { name, at } } in one meta row, a week at most.
const asked = () => {
  let a = {};
  try {
    a = JSON.parse(db.get("telegram:asked") || "{}") || {};
  } catch {}
  for (const [id, r] of Object.entries(a)) if (!(Date.now() - Date.parse(r?.at) < 7 * 86400000)) delete a[id];
  return a;
};
const setAsked = (a) => db.set("telegram:asked", JSON.stringify(a));

onAction("tgallow", (id) => {
  const a = asked();
  const r = a[id];
  if (!r?.name) return "Запит застарів.";
  delete a[id];
  setAsked(a);
  if (!extra().some((c) => String(c.id) === id)) setExtra([...extra(), { id, name: r.name }]);
  send(`${HELLO}\nВимкнути: /off`, id);
  return `Доступ є: ${r.name}`;
});
onAction("tgdeny", (id) => {
  const a = asked();
  if (a[id]) setAsked({ ...a, [id]: { at: a[id].at } });
  return "Відмовлено.";
});
onAction("tgdrop", (id) => {
  const c = extra().find((x) => String(x.id) === id);
  if (!c) return "Уже забрано.";
  setExtra(extra().filter((x) => String(x.id) !== id));
  send("Доступ до бота забрали.", id);
  return `Забрано: ${c.name}`;
});

// A message from the linked chat or an allowed one: a command of the handler's, else a bug report (bugbox.js).
function mine(m, id, hint) {
  const text = m.text || "";
  if (/^\/\w+/.test(text)) {
    if (onCmd) {
      const r = onCmd(text, id);
      if (r) return r;
    }
    return send(`Баг чи «щось не працює»: напишіть, надішліть скріншот або войс.\nВідкриті: /bugs\n${hint}`, id);
  }
  if (onMsg) return Promise.resolve(onMsg(m, id)).catch((e) => (console.error(`[telegram] report: ${e.message}`), send(`Не зміг записати: ${e.message}`, id)));
  return send(`Я лише надсилаю сповіщення сайту Chytai.\n${hint}`, id);
}

// An update from Telegram: /start links the first chat; after that someone else's /start asks the linked chat.
function update(u) {
  if (u?.callback_query) return pressed(u.callback_query);
  const m = u?.message;
  if (!m?.chat?.id || m.chat.type !== "private" || !db) return;
  const id = String(m.chat.id);
  const text = m.text || "";
  if (!chat() && /^\/start\b/.test(text)) {
    db.set("telegram:chat", id);
    console.log(`[telegram] linked chat ${id}`);
    return send(HELLO, id);
  }
  if (id === chat()) {
    if (/^\/who\b/.test(text)) {
      const l = extra();
      if (!l.length) return send("Крім вас, бот нікому не пише.", id);
      return send(`Бот пише ще: ${l.map((c) => c.name).join(", ")}`, id, l.map((c) => [{ text: `Забрати: ${c.name}`.slice(0, 60), data: `tgdrop:${c.id}` }]));
    }
    return mine(m, id, "Кому ще пишу: /who");
  }
  if (extra().some((c) => String(c.id) === id)) {
    if (/^\/off\b/.test(text)) {
      setExtra(extra().filter((c) => String(c.id) !== id));
      return send("Більше не пишу. Знову: /start", id);
    }
    return mine(m, id, "Вимкнути: /off");
  }
  if (/^\/start\b/.test(text) && chat()) {
    // One request a day per chat, so a stranger can't flood the owner.
    const a = asked();
    if (Date.now() - Date.parse(a[id]?.at) < 86400000) return send("Запит уже надіслано. Чекайте.", id);
    setAsked({ ...a, [id]: { name: who(m.from), at: new Date().toISOString() } });
    send(`Просить доступ до бота: ${who(m.from)}`, chat(), [[{ text: "Дозволити", data: `tgallow:${id}` }, { text: "Ні", data: `tgdeny:${id}` }]]);
    return send("Це приватний бот. Запит на доступ надіслано власнику.", id);
  }
  return send("Це приватний бот. Попросити доступ: /start", id);
}

module.exports = { on, init, send, onAction, sendOnce, setWebhook, update, hookPath, chat, chats, file, onMessage, onCommand, who };
