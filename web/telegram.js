// Messages to the owner in Telegram (Max, 2026-11-04: «я імейлом майже не користуюсь … подумати про альтернативний
// канал зв'язку зі мною»). One private bot: TELEGRAM_BOT_TOKEN in Fly secrets of chytai-web. The chat it writes to
// is TELEGRAM_CHAT_ID, or the first chat that sent the bot /start (kept in meta `telegram:chat`); after that the
// bot answers nobody else. Without a token nothing is sent and nothing breaks.
//
// Sent: everything notifyOwner mails (readers' lists, comments, books…), a wave of sign-ups, a background job that
// failed, the reader app not answering (and answering again). Never readers' e-mail addresses.
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `${process.env.TELEGRAM_API || "https://api.telegram.org"}/bot${TOKEN}`; // TELEGRAM_API: a stand-in for tests
let db = null;

const on = () => !!TOKEN;
// The webhook's path carries a secret made from the token, so nobody else can post updates to it.
const hookPath = () => (TOKEN ? `/api/telegram/${crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 32)}` : "");
const chat = () => process.env.TELEGRAM_CHAT_ID || db?.get("telegram:chat") || "";

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
// Plain text, cut to Telegram's limit, with optional buttons under it ([[{ text, data }]]). Never throws.
function send(text, to = chat(), buttons = null) {
  if (!TOKEN || !to) return Promise.resolve(false);
  text = String(text || "").trim();
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  const markup = buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {};
  return call("sendMessage", { chat_id: to, text, disable_web_page_preview: true, ...markup })
    .then(() => true)
    .catch((e) => (console.error(`[telegram] ${e.message}`), false));
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
// An update from Telegram: /start links the first chat; the linked chat gets a short help, others a refusal.
function update(u) {
  if (u?.callback_query) return pressed(u.callback_query);
  const m = u?.message;
  if (!m?.chat?.id || m.chat.type !== "private") return;
  const id = String(m.chat.id);
  if (!chat() && db && /^\/start\b/.test(m.text || "")) {
    db.set("telegram:chat", id);
    console.log(`[telegram] linked chat ${id}`);
    return send("Підключено. Сюди приходитимуть новини сайту Chytai: що створюють читачі, хвилі реєстрацій, збої.", id);
  }
  if (id === chat()) return send("Я лише надсилаю сповіщення сайту Chytai.", id);
  return send("Це приватний бот.", id);
}

module.exports = { on, init, send, onAction, sendOnce, setWebhook, update, hookPath, chat };
