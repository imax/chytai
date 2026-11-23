// Bug reports from Max's Telegram (Max, 2026-11-18: «щоб я міг через Telegram-адмінбот пересилати баг-репорти,
// якийсь скріншот, або войс, або текстом … і ти це ставив в чергу»). Whatever the linked chat or a chat Max allowed
// (telegram.js `extra`) writes to the bot, other than a command, is a report: text, a screenshot or other file, a
// voice (transcribed by our Telegram account, tgfeed `transcribe`), a forward (who it came from), a reply to one of the
// bot's alerts (the alert's text goes with it). A message within JOIN_SEC of the last one joins it (Max 2026-11-22,
// bug report №39: «ще одне повідомлення протягом 30 секунд підклеюється до попереднього»; 3 minutes glued different
// things, 2026-11-21); so do the rest of an album, words within GAP_MIN after a screenshot or file sent with no
// words («скріншот, потім пояснення»), and a reply to the bot's «Записав №N» / «Додав до №N» (joins №N).
//
// The morning error review (CLAUDE.md) works them: GET /agent/bugs (open ones, their files at /agent/bugs/<id>/<file>),
// fixes, then POST /agent/bugs/<id> { status: done | skip | later, note }; done and skip answer Max under his message.
// Files in DATA_DIR/web/bugs/<id>/: gone FILES_DONE_DAYS after a report is closed, FILES_MAX_DAYS after it came in
// whatever its state; rows ROWS_DAYS.
const fs = require("fs");
const path = require("path");

const GAP_MIN = 3;
const JOIN_SEC = 30;
const FILES_DONE_DAYS = 14;
const FILES_MAX_DAYS = 60;
const ROWS_DAYS = 180;
const MAX_FILE = 20 * 1024 * 1024; // the Bot API's own limit
const DAY = 86400000;
const STATUS = { new: "новий", done: "виправлено", skip: "не баг", later: "на потім" };

const SCHEMA = `CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, last TEXT NOT NULL, chat TEXT NOT NULL, msg INTEGER NOT NULL DEFAULT 0,
  who TEXT NOT NULL DEFAULT '', parts TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'new',
  note TEXT NOT NULL DEFAULT '', closed TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bug_reports_status ON bug_reports (status, at);`;
// parts: [{ at, kind: text | photo | file | voice | video, text, file, from, reply, error }]

const clip = (t, n) => String(t || "").trim().slice(0, n);
// Where a forward came from: a person, a channel, a hidden sender.
function origin(m) {
  const o = m.forward_origin;
  if (o) return clip(o.sender_user ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ") + (o.sender_user.username ? ` (@${o.sender_user.username})` : "") : o.chat?.title || o.sender_user_name || o.sender_chat?.title || "", 120) || "переслано";
  if (m.forward_from || m.forward_sender_name || m.forward_from_chat) return clip(m.forward_from?.first_name || m.forward_sender_name || m.forward_from_chat?.title, 120) || "переслано";
  return "";
}
// The message's file worth keeping: the biggest photo, a document, a voice, audio, a video note.
function media(m) {
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    return { kind: "photo", id: p.file_id, size: p.file_size, ext: "jpg" };
  }
  if (m.voice) return { kind: "voice", id: m.voice.file_id, size: m.voice.file_size, ext: "ogg", duration: m.voice.duration };
  if (m.audio) return { kind: "voice", id: m.audio.file_id, size: m.audio.file_size, ext: (m.audio.file_name || "").split(".").pop() || "mp3", duration: m.audio.duration };
  if (m.video_note) return { kind: "video", id: m.video_note.file_id, size: m.video_note.file_size, ext: "mp4" };
  if (m.video) return { kind: "video", id: m.video.file_id, size: m.video.file_size, ext: "mp4" };
  if (m.document) {
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(m.document.file_name || "")?.[1] || "bin").toLowerCase();
    return { kind: /^image\//.test(m.document.mime_type || "") ? "photo" : "file", id: m.document.file_id, size: m.document.file_size, ext, name: clip(m.document.file_name, 80) };
  }
  return null;
}

function create(db, { dir, telegram, transcribe = null, log = console.log } = {}) {
  db.exec(SCHEMA);
  const get = (id) => db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(id);
  const partsOf = (r) => {
    try {
      return JSON.parse(r.parts || "[]");
    } catch {
      return [];
    }
  };
  const save = (id, parts) => db.prepare("UPDATE bug_reports SET parts = ?, last = ? WHERE id = ?").run(JSON.stringify(parts), new Date().toISOString(), id);

  // Old files and rows go (once an hour at most, from take and list).
  let pruned = 0;
  function prune(now = Date.now()) {
    if (now - pruned < 3600000) return;
    pruned = now;
    const gone = db
      .prepare("SELECT id FROM bug_reports WHERE (closed != '' AND closed < ?) OR at < ?")
      .all(new Date(now - FILES_DONE_DAYS * DAY).toISOString(), new Date(now - FILES_MAX_DAYS * DAY).toISOString());
    for (const r of gone) fs.rmSync(path.join(dir, String(r.id)), { recursive: true, force: true });
    db.prepare("DELETE FROM bug_reports WHERE at < ?").run(new Date(now - ROWS_DAYS * DAY).toISOString());
  }

  // A message from Max's chat (telegram.js `mine`) → kept; answers in the chat.
  async function take(m, chat) {
    prune();
    const now = new Date();
    const f = media(m);
    const part = { at: now.toISOString(), kind: f ? f.kind : "text", text: clip(m.text || m.caption, 4000) };
    const from = origin(m);
    if (from) part.from = from;
    const rep = m.reply_to_message;
    if (rep && !from) part.reply = clip(rep.text || rep.caption, 1000) || "(повідомлення без тексту)";
    if (!part.text && !f) return telegram.send("Такого не вмію зберегти. Напишіть текстом, скріншотом або войсом.", chat, null, m.message_id);

    // The same album, anything within JOIN_SEC, words just after a screenshot that had none, or a reply to the bot's
    // «№N»: one report.
    const album = m.media_group_id ? String(m.media_group_id) : "";
    const toBot = rep?.from?.is_bot && /^(?:Записав |Додав до )?№(\d+)[.,:]/.exec(rep.text || "");
    const named = toBot && db.prepare("SELECT * FROM bug_reports WHERE id = ? AND chat = ? AND status = 'new'").get(Number(toBot[1]), chat);
    if (toBot) delete part.reply;
    const last = named || db.prepare("SELECT * FROM bug_reports WHERE chat = ? AND status = 'new' ORDER BY id DESC LIMIT 1").get(chat);
    const wordless = last && partsOf(last).every((p) => !p.text && p.kind !== "voice");
    // Since its last message came (not `last`: a voice's words are written into it up to two minutes later).
    const since = last ? now - Date.parse(partsOf(last).at(-1)?.at || last.last) : Infinity;
    const join = !!last && (!!named || (album && last.album === album) || since < JOIN_SEC * 1000 || (wordless && since < GAP_MIN * 60000));
    let id;
    if (join) id = last.id;
    else {
      id = db
        .prepare("INSERT INTO bug_reports (at, last, chat, msg, who, album) VALUES (?, ?, ?, ?, ?, ?)")
        .run(part.at, part.at, chat, m.message_id || 0, clip(telegram.who(m.from), 120), album).lastInsertRowid;
    }
    if (album) db.prepare("UPDATE bug_reports SET album = ? WHERE id = ?").run(album, id);

    if (f) {
      try {
        if (f.size > MAX_FILE) throw new Error("файл понад 20 МБ");
        const buf = await telegram.file(f.id);
        const folder = path.join(dir, String(id));
        fs.mkdirSync(folder, { recursive: true });
        const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${f.kind}.${f.ext.replace(/[^a-z0-9]/gi, "")}`;
        fs.writeFileSync(path.join(folder, name), buf);
        part.file = name;
        if (f.name) part.name = f.name;
      } catch (e) {
        part.error = clip(e.message, 200);
      }
    }
    // Several parts can come in at once (an album): read the row again just before writing.
    save(id, [...partsOf(get(id)), part]);
    log(`bugs: #${id} ${join ? "+" : "new"} ${part.kind}`);

    const quiet = join && album && last.album === album; // the rest of an album: one answer is enough
    if (part.kind === "voice" && part.file) {
      const heard = await hear(id, part, f.duration);
      return telegram.send(heard.text ? `№${id}, почув так:\n«${clip(heard.text, 3000)}»` : `№${id}: войс зберіг, але не розшифрувався (${heard.error}). Краще напишіть текстом.`, chat, null, m.message_id);
    }
    if (quiet) return;
    if (part.error) return telegram.send(`№${id}: текст зберіг, файл ні (${part.error}).`, chat, null, m.message_id);
    return telegram.send(join ? `Додав до №${id}.` : `Записав №${id}. Візьму на ранковому розборі помилок.`, chat, null, m.message_id);
  }
  // A voice → its words in the part (tgfeed `transcribe` in the jobs process; two minutes at most).
  async function hear(id, part, duration = 0) {
    if (!transcribe) return { error: "немає розшифровки" };
    const file = path.join(dir, String(id), part.file);
    const r = await Promise.race([Promise.resolve(transcribe(file, duration)).catch((e) => ({ error: e.message })), new Promise((ok) => setTimeout(() => ok({ error: "задовго" }), 120000))]);
    const parts = partsOf(get(id));
    const p = parts.find((x) => x.file === part.file);
    if (p) {
      if (r?.text) p.text = clip(r.text, 4000);
      else p.error = clip(r?.error || "?", 200);
      save(id, parts);
    }
    return r || { error: "?" };
  }

  // For the morning review: open reports (status new) or all of `days`.
  function list({ all = false, days = 30 } = {}) {
    prune();
    const rows = all
      ? db.prepare("SELECT * FROM bug_reports WHERE at >= ? ORDER BY id DESC").all(new Date(Date.now() - days * DAY).toISOString())
      : db.prepare("SELECT * FROM bug_reports WHERE status = 'new' ORDER BY id").all();
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      who: r.who,
      status: r.status,
      note: r.note || undefined,
      closed: r.closed || undefined,
      parts: partsOf(r).map((p) => ({ ...p, file: p.file && fs.existsSync(path.join(dir, String(r.id), p.file)) ? `/agent/bugs/${r.id}/${p.file}` : p.file ? "(видалено)" : undefined })),
    }));
  }
  const open = () => db.prepare("SELECT COUNT(*) n FROM bug_reports WHERE status = 'new'").get().n;
  // A report's file, for GET /agent/bugs/<id>/<name>: its path or null.
  function filePath(id, name) {
    if (!/^\d+$/.test(String(id)) || !/^[\w-]+\.[a-z0-9]{1,5}$/i.test(String(name))) return null;
    const p = path.join(dir, String(id), name);
    return fs.existsSync(p) ? p : null;
  }
  // The review closes one: done / skip answer Max under his first message; later only notes it.
  function mark(id, status, note = "") {
    const r = get(+id);
    if (!r) return { error: "no such report" };
    if (!STATUS[status]) return { error: `status: ${Object.keys(STATUS).join(" | ")}` };
    note = clip(note, 600);
    db.prepare("UPDATE bug_reports SET status = ?, note = ?, closed = ? WHERE id = ?").run(status, note, status === "new" ? "" : new Date().toISOString(), r.id);
    if (status === "done" || status === "skip") telegram.send(`№${r.id}: ${STATUS[status]}.${note ? ` ${note}` : ""}`, r.chat, null, r.msg);
    return { id: r.id, status, note };
  }
  // /bugs in the chat: the open ones in a line each.
  function command(text, chat) {
    if (!/^\/bugs\b/.test(text)) return null;
    const l = list();
    if (!l.length) return telegram.send("Відкритих баг-репортів немає.", chat);
    const line = (r) => {
      const t = r.parts.map((p) => p.text).filter(Boolean).join(" ").replace(/\s+/g, " ");
      const n = r.parts.filter((p) => p.file).length;
      return `№${r.id} ${r.at.slice(5, 10)}: ${clip(t, 90) || "(без тексту)"}${n ? ` [файлів ${n}]` : ""}`;
    };
    return telegram.send(`Відкриті (${l.length}):\n${l.slice(-20).map(line).join("\n")}`, chat);
  }

  return { take, list, open, mark, filePath, command, prune, STATUS };
}

module.exports = { create, media, origin };
