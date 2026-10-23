// Chytai in a chat (2026-10-23, an idea from a reader that Max OK'd: «Давай спробуємо»): a remote MCP server at /mcp,
// so a reader can say to Claude or ChatGPT «додай Тигроловів у прочитане» or «додай усе, що знаєш, що я читав»
// and the books land on their shelf. The chat's own model does all the thinking; we only answer its calls, so
// it costs us no tokens.
//   - Sign-in is OAuth 2.1 as remote MCP connectors expect it: the chat finds us through the two .well-known
//     documents, registers itself (or names its client metadata document by URL), sends the reader to
//     /oauth/authorize, where they sign in with the usual e-mail code and press «Дозволити», and trades the code
//     (PKCE) for tokens. Each such permission is a «grant»: /settings/chats lists them, «Відключити» deletes one
//     with its tokens. Tokens are random; the database keeps only their hashes, as with sessions.
//   - Tools: search_books, list_my_books, add_books, update_book. Nothing takes a book off the shelf (that
//     stays on the site). A pasted list never floods the feed: more than three new books at once are dated to
//     the year they were read, like the /add and Goodreads imports (Max, 2026-10-20).
//   - Limits a reader a day: 200 calls, 300 books added; 100 books in one call.
// The answers are JSON-RPC over plain HTTP POST (the Streamable HTTP transport without a stream: no
// notifications from us, so a JSON reply is all a call needs).
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { privateIp } = require("./bookpage");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rand = (prefix) => `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
const nowIso = () => new Date().toISOString();

const CODE_TTL = 10 * 60 * 1000;
const ACCESS_TTL = 7 * 24 * 3600 * 1000;
const REFRESH_TTL = 365 * 24 * 3600 * 1000;
const CALLS_A_DAY = 200;
const BOOKS_A_DAY = 300;
const BOOKS_A_CALL = 100;
const QUIET_FROM = 4; // this many new books or more in one call are history, not news, and skip the feed
const STATUSES = ["read", "reading", "want", "abandoned"];
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, reader TEXT NOT NULL, client TEXT NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL, used TEXT);
CREATE INDEX IF NOT EXISTS oauth_grants_reader ON oauth_grants (reader);
CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id);
`;

// Where a chat may send the reader back: https, the computer's own loopback over http (desktop apps, the MCP
// inspector), or an app's own scheme («cursor://…»), never a script.
function okRedirect(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(url.protocol);
}
// A loopback address may come back on any port (RFC 8252); everything else must match exactly.
function sameRedirect(registered, given) {
  if (registered === given) return true;
  try {
    const [a, b] = [new URL(registered), new URL(given)];
    return a.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

class Mcp {
  // deps: store, auth, pages; site(req) the public origin; notifyOwner(subject, text); details({ ids }) fetches
  // covers and details of new books; dropNow(reader, id) takes a book off «Читаю зараз».
  constructor({ store, auth, pages, site, notifyOwner, details, dropNow, log = console.log }) {
    Object.assign(this, { store, auth, pages, site, notifyOwner, details, dropNow, log });
    this.db = store.db;
    this.db.exec(SCHEMA);
    this.metaCache = new Map(); // client metadata document URL -> { at, client }
    this.counts = new Map(); // `${day}:${reader}:${what}` -> number
  }

  // ---- clients ----

  client(id) {
    id = String(id || "");
    const row = this.db.prepare("SELECT data FROM oauth_clients WHERE id = ?").get(id);
    return row ? { id, ...JSON.parse(row.data) } : null;
  }
  register(body) {
    const uris = [].concat(body?.redirect_uris || []).map(String);
    if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) return { error: "invalid_redirect_uri", error_description: "redirect_uris: https, loopback http or an app scheme" };
    const name = String(body.client_name || "").replace(/\s+/g, " ").trim().slice(0, 80) || new URL(uris[0]).hostname || "Чат";
    const id = `chytai-${crypto.randomBytes(12).toString("hex")}`;
    const data = { name, redirect_uris: uris, uri: /^https:\/\//.test(body.client_uri || "") ? String(body.client_uri).slice(0, 200) : "" };
    this.db.prepare("INSERT INTO oauth_clients (id, data, created) VALUES (?, ?, ?)").run(id, JSON.stringify(data), nowIso());
    return { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }
  // A client that names itself by the URL of its metadata document (the newer MCP way, no registration):
  // fetched once an hour at most, public addresses only, small.
  async clientByUrl(id) {
    let url;
    try {
      url = new URL(id);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.pathname === "/") return null;
    const hit = this.metaCache.get(id);
    if (hit && Date.now() - hit.at < 3600 * 1000) return hit.client;
    let client = null;
    try {
      const ips = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
      if (!ips.length || ips.some(privateIp)) throw new Error("not a public address");
      const res = await fetch(url.href, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok || text.length > 20000) throw new Error(`HTTP ${res.status}`);
      const doc = JSON.parse(text);
      const uris = [].concat(doc.redirect_uris || []).map(String);
      if (doc.client_id !== id || !uris.length || !uris.every(okRedirect)) throw new Error("bad metadata document");
      client = { id, name: String(doc.client_name || url.hostname).slice(0, 80), redirect_uris: uris, uri: /^https:\/\//.test(doc.client_uri || "") ? String(doc.client_uri).slice(0, 200) : "" };
    } catch (e) {
      this.log(`mcp: client metadata ${id}: ${e.message}`);
    }
    this.metaCache.set(id, { at: Date.now(), client });
    return client;
  }
  async findClient(id) {
    return this.client(id) || (/^https:\/\//.test(String(id || "")) ? this.clientByUrl(String(id)) : null);
  }

  // ---- codes and tokens ----

  makeCode({ reader, client, redirectUri, challenge }) {
    const code = rand("cc_");
    this.db.prepare("DELETE FROM oauth_tokens WHERE kind = 'code' AND expires < ?").run(Date.now());
    this.db.prepare("INSERT INTO oauth_tokens (hash, grant_id, kind, expires, data) VALUES (?, '', 'code', ?, ?)").run(sha(code), Date.now() + CODE_TTL, JSON.stringify({ reader, client: client.id, name: client.name, redirectUri, challenge }));
    return code;
  }
  issue(grantId) {
    const access = rand("ca_");
    const refresh = rand("cr_");
    const ins = this.db.prepare("INSERT INTO oauth_tokens (hash, grant_id, kind, expires) VALUES (?, ?, ?, ?)");
    ins.run(sha(access), grantId, "access", Date.now() + ACCESS_TTL);
    ins.run(sha(refresh), grantId, "refresh", Date.now() + REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: "books" };
  }
  // POST /oauth/token. Returns [status, body].
  token(b) {
    const fail = (error, error_description = "") => [400, { error, ...(error_description ? { error_description } : {}) }];
    if (b.grant_type === "authorization_code") {
      const h = sha(String(b.code || ""));
      const row = this.db.prepare("SELECT data, expires FROM oauth_tokens WHERE hash = ? AND kind = 'code'").get(h);
      if (!row) return fail("invalid_grant", "unknown or used code");
      this.db.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(h); // a code works once
      const c = JSON.parse(row.data);
      if (row.expires < Date.now()) return fail("invalid_grant", "code expired");
      if (b.client_id && b.client_id !== c.client) return fail("invalid_grant", "client mismatch");
      if (b.redirect_uri && b.redirect_uri !== c.redirectUri) return fail("invalid_grant", "redirect_uri mismatch");
      const verifier = String(b.code_verifier || "");
      if (!verifier || crypto.createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return fail("invalid_grant", "PKCE check failed");
      // One permission per reader and chat: allowing the same chat again replaces the old one.
      this.db.tx(() => {
        for (const g of this.db.prepare("SELECT id FROM oauth_grants WHERE reader = ? AND client = ?").all(c.reader, c.client)) this.revoke(c.reader, g.id);
      });
      const grant = crypto.randomBytes(12).toString("hex");
      this.db.prepare("INSERT INTO oauth_grants (id, reader, client, name, created) VALUES (?, ?, ?, ?, ?)").run(grant, c.reader, c.client, c.name, nowIso());
      this.log(`mcp: @${this.auth.reader(c.reader)?.username} connected ${c.name}`);
      return [200, this.issue(grant)];
    }
    if (b.grant_type === "refresh_token") {
      const h = sha(String(b.refresh_token || ""));
      const row = this.db.prepare("SELECT t.grant_id, t.expires, g.client FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = 'refresh'").get(h);
      if (!row || row.expires < Date.now()) return fail("invalid_grant", "unknown or expired refresh token");
      if (b.client_id && b.client_id !== row.client) return fail("invalid_grant", "client mismatch");
      this.db.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(h);
      this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ? AND kind = 'access' AND expires < ?").run(row.grant_id, Date.now());
      return [200, this.issue(row.grant_id)];
    }
    return fail("unsupported_grant_type");
  }
  // The reader behind a bearer token, or null.
  readerOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!m) return null;
    const row = this.db.prepare("SELECT t.expires, g.id, g.reader, g.name FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = 'access'").get(sha(m[1]));
    if (!row || row.expires < Date.now()) return null;
    const reader = this.auth.reader(row.reader);
    if (!reader) return null;
    this.db.prepare("UPDATE oauth_grants SET used = ? WHERE id = ?").run(nowIso(), row.id);
    return { reader, client: row.name };
  }

  // The chats a reader let in, for /settings/chats.
  grants(reader) {
    return this.db.prepare("SELECT id, name, created, used FROM oauth_grants WHERE reader = ? ORDER BY created DESC").all(reader);
  }
  revoke(reader, grantId) {
    const g = this.db.prepare("SELECT id FROM oauth_grants WHERE id = ? AND reader = ?").get(grantId, reader);
    if (!g) return false;
    this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").run(g.id);
    this.db.prepare("DELETE FROM oauth_grants WHERE id = ?").run(g.id);
    return true;
  }
  forgetReader(reader) {
    for (const g of this.grants(reader)) this.revoke(reader, g.id);
  }

  // ---- daily limits ----

  used(reader, what, add = 0) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${reader}:${what}`;
    if (this.counts.size > 5000) for (const k of this.counts.keys()) if (!k.startsWith(day)) this.counts.delete(k);
    const n = (this.counts.get(key) || 0) + add;
    this.counts.set(key, n);
    return n;
  }

  // ---- the MCP side ----

  tools() {
    const status = { type: "string", enum: STATUSES, description: "read = прочитано, reading = читаю зараз, want = хочу прочитати, abandoned = покинуто" };
    const rating = { type: "number", minimum: 1, maximum: 5, description: "1 to 5 stars, halves allowed. Only when the reader said it; never guess." };
    const year = { type: "integer", minimum: 1900, maximum: 2100, description: "Year the reader finished the book, if known" };
    return [
      {
        name: "search_books",
        title: "Шукати книжки",
        description: "Search the Chytai catalog (mostly books in Ukrainian, plus originals in English and other languages). Ukrainian titles and authors in Cyrillic work best; try the original title too. Returns book ids to use with add_books and update_book, and whether the book is already on the reader's shelf.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Title and/or author" }, limit: { type: "integer", minimum: 1, maximum: 20, default: 8 } }, required: ["query"] },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "list_my_books",
        title: "Моя полиця",
        description: "The signed-in reader's own shelf on Chytai: every book with its status, rating, year read and note. Check it before adding books so nothing is added twice.",
        inputSchema: { type: "object", properties: { status: { ...status, description: `Only books with this status. ${status.description}` }, limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 } } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "add_books",
        title: "Додати книжки",
        description: `Add books to the reader's shelf, one or many (up to ${BOOKS_A_CALL} per call). Give each book an id from search_books, or a title and author: we look it up in the catalog. A book we cannot find comes back as not_found with candidates; call again with the right id, or with create_if_missing: true when the book is really missing from the catalog. A book already on the shelf is left as it is (use update_book to change it).`,
        inputSchema: {
          type: "object",
          properties: {
            books: {
              type: "array",
              minItems: 1,
              maxItems: BOOKS_A_CALL,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Book id from search_books" },
                  title: { type: "string" },
                  author: { type: "string" },
                  status,
                  rating,
                  year,
                  note: { type: "string", maxLength: 2000, description: "The reader's own short note. It is public on their shelf, so only what they asked to write." },
                  create_if_missing: { type: "boolean", default: false, description: "Add the book to the catalog if it is not there" },
                },
                required: ["status"],
              },
            },
          },
          required: ["books"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "update_book",
        title: "Змінити книжку на полиці",
        description: "Change the status, rating, year or note of a book on the reader's shelf (a book not yet there is added). Books cannot be removed this way; the reader does that on the site.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "Book id from list_my_books or search_books" }, status, rating: { ...rating, minimum: 0, description: "1 to 5 stars, halves allowed; 0 clears the rating" }, year, note: { type: "string", maxLength: 2000 } }, required: ["id"] },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ];
  }

  bookOut(b, reader, { full = false } = {}) {
    const e = reader ? this.store.entry(reader, b.id) : null;
    return {
      id: b.id,
      title: b.title,
      author: b.author || "",
      ...(b.altTitle ? { original_title: b.altTitle } : {}),
      ...(b.published ? { published: b.published } : {}),
      url: `${this.origin}${b.href || this.store.href(b.id)}`,
      ...(e ? { on_my_shelf: { status: e.status || null, rating: e.rating ?? null, year: e.year ?? null, ...(full && e.note ? { note: e.note } : {}) } } : {}),
    };
  }

  search_books(reader, { query, limit = 8 }) {
    const q = String(query || "").trim().slice(0, 100);
    if (!q) throw new Error("query is empty");
    const hits = this.store.search(q, { reader: reader.id, limit: Math.max(1, Math.min(20, Number(limit) || 8)) });
    return { books: hits.map((h) => this.bookOut(h.book, reader.id)) };
  }

  list_my_books(reader, { status, limit = 500 }) {
    let rows = this.store.library(reader.id);
    if (status) rows = rows.filter((r) => r.status === status);
    const total = rows.length;
    rows = rows.slice(0, Math.max(1, Math.min(2000, Number(limit) || 500)));
    return {
      total,
      books: rows.map((r) => ({ id: r.id, title: r.book.title, author: r.book.author || "", status: r.status || null, rating: r.rating ?? null, year: r.year ?? null, ...(r.note ? { note: r.note } : {}), ...(r.kids ? { kids_shelf: true } : {}) })),
      shelf_url: `${this.origin}/@${reader.username}`,
    };
  }

  add_books(reader, { books }) {
    books = [].concat(books || []);
    if (!books.length) throw new Error("books is empty");
    if (books.length > BOOKS_A_CALL) throw new Error(`At most ${BOOKS_A_CALL} books per call`);
    const left = BOOKS_A_DAY - this.used(reader.id, "books");
    const results = [];
    const rows = [];
    const thisYear = new Date().getFullYear();
    const taken = new Set(); // one book named twice in a list goes in once
    for (const [i, x] of books.entries()) {
      const title = String(x?.title || "").trim().slice(0, 200);
      const author = String(x?.author || "").trim().slice(0, 200);
      const status = STATUSES.includes(x?.status) ? x.status : null;
      const out = { input: x?.id || [title, author].filter(Boolean).join(" — ") || `#${i + 1}` };
      if (!status) {
        results.push({ ...out, result: "error", error: `status must be one of ${STATUSES.join(", ")}` });
        continue;
      }
      let id = x.id ? this.store.resolve(String(x.id)) : null;
      if (x.id && !id) {
        results.push({ ...out, result: "error", error: "unknown id" });
        continue;
      }
      if (!id && !title) {
        results.push({ ...out, result: "error", error: "give an id or a title" });
        continue;
      }
      if (!id) id = this.store.findWork({ title, author });
      if (id) id = this.store.canonical(id);
      if (id && taken.has(id)) {
        results.push({ ...out, result: "duplicate_in_this_call" });
        continue;
      }
      if (id && this.store.entry(reader.id, id)) {
        results.push({ ...out, result: "already_on_shelf", book: this.bookOut(this.store.book(id), reader.id) });
        continue;
      }
      if (!id && !x.create_if_missing) {
        const candidates = this.store.search([title, author].join(" "), { reader: reader.id, limit: 3 });
        const fallback = candidates.length ? candidates : this.store.search(title, { reader: reader.id, limit: 3 });
        results.push({ ...out, result: "not_found", candidates: fallback.map((h) => this.bookOut(h.book, reader.id)) });
        continue;
      }
      if (rows.length >= left) {
        results.push({ ...out, result: "error", error: `daily limit of ${BOOKS_A_DAY} new books reached; try tomorrow` });
        continue;
      }
      const r = Number(x.rating);
      const rating = status === "want" || status === "reading" || !(r >= 1 && r <= 5) ? null : Math.round(r * 2) / 2;
      const year = status === "read" && Number.isInteger(Number(x.year)) && x.year >= 1900 && x.year <= thisYear ? Number(x.year) : null;
      // A book with no id yet is the one to make (importEntries makes it; findWork found nothing).
      if (id) taken.add(id);
      rows.push({ i, out, row: { id, title, author, status, rating, year, note: String(x.note || "").trim().slice(0, 2000) } });
      results.push(null);
    }
    // A few books are news (the reader just finished one); a long list is the past and goes in quietly, dated
    // to the year it was read, like a pasted list on /add.
    const quiet = rows.length >= QUIET_FROM;
    const now = nowIso();
    const res = rows.length ? this.store.importEntries(reader.id, rows.map(({ row }) => ({ ...row, touched: quiet ? `${row.year || thisYear}-01-01T00:00:00.000Z` : now, added: now.slice(0, 10) })), { source: "chat" }) : { created: [] };
    const made = new Map(res.created.map((b) => [`${b.title}|${b.author}`, b]));
    for (const { i, out, row } of rows) {
      const id = row.id || made.get(`${row.title}|${row.author}`)?.id || this.store.findWork(row);
      const b = id && this.store.book(id);
      results[i] = { ...out, result: row.id ? "added" : "added_new_to_catalog", ...(b ? { book: this.bookOut(b, reader.id) } : {}) };
      if (b && ["read", "want", "abandoned"].includes(row.status)) this.dropNow(reader.id, b.id);
    }
    this.used(reader.id, "books", rows.length);
    if (res.created.length) {
      this.details({ ids: res.created.map((b) => b.id) });
      if (reader.id !== "owner")
        this.notifyOwner(`Чат: ${res.created.length} нових книжок`, [`${reader.name} (@${reader.username}) додав(ла) через чат книжки, яких не було в каталозі:`, "", ...res.created.slice(0, 100).map((b) => `• ${b.title}${b.author ? ` — ${b.author}` : ""}  ${this.origin}${this.store.href(b.id)}`), "", `Полиця читача: ${this.origin}/@${reader.username}`].join("\n"));
    }
    this.log(`mcp: @${reader.username} add_books: ${rows.length} added (${res.created.length} new), ${results.length - rows.length} not`);
    return { added: rows.length, results, shelf_url: `${this.origin}/@${reader.username}` };
  }

  update_book(reader, { id, status, rating, year, note }) {
    const bookId = id && this.store.resolve(String(id));
    if (!bookId || !this.store.book(bookId)) throw new Error("unknown id; find it with search_books or list_my_books");
    const patch = {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
      Object.assign(patch, { status, kids: false });
    }
    if (rating !== undefined && rating !== null) {
      const r = Number(rating);
      if (!(r >= 0 && r <= 5)) throw new Error("rating is 1 to 5, or 0 to clear it");
      patch.rating = r === 0 ? null : Math.round(r * 2) / 2;
    }
    if (year !== undefined && year !== null) patch.year = Number(year) || null;
    if (note !== undefined && note !== null) patch.note = String(note).trim().slice(0, 2000);
    if (!Object.keys(patch).length) throw new Error("nothing to change");
    if (!this.store.entry(reader.id, bookId)) {
      if (this.used(reader.id, "books") >= BOOKS_A_DAY) throw new Error(`daily limit of ${BOOKS_A_DAY} new books reached; try tomorrow`);
      this.used(reader.id, "books", 1);
    }
    this.store.setEntry(reader.id, bookId, patch);
    if (["read", "want", "abandoned"].includes(patch.status)) this.dropNow(reader.id, bookId);
    return { book: this.bookOut(this.store.book(bookId), reader.id, { full: true }) };
  }

  // One JSON-RPC message; returns the reply, or null for a notification.
  call(who, msg) {
    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "Invalid Request");
    if (msg.id === undefined) return null; // notifications/initialized and the like: nothing to say back
    const p = msg.params || {};
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "chytai", title: "Chytai", version: "1.0.0", websiteUrl: this.origin },
          instructions:
            "Chytai (chytai.org.ua) is a Ukrainian site where readers keep a public shelf of the books they read, are reading, want to read or abandoned, with ratings and notes. These tools act on the signed-in reader's own shelf. Before adding many books, call list_my_books to skip what is already there. Prefer the Ukrainian edition when the catalog has one. Only add books the reader actually confirmed, never guessed ratings, and tell the reader what was added and what was not found. Answer the reader in their language (usually Ukrainian).",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.tools() });
      case "tools/call": {
        const name = String(p.name || "");
        if (!this.tools().some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`);
        if (this.used(who.reader.id, "calls", 1) > CALLS_A_DAY) return reply({ content: [{ type: "text", text: `Daily limit of ${CALLS_A_DAY} calls reached. Try again tomorrow.` }], isError: true });
        try {
          const data = this[name](who.reader, p.arguments || {});
          return reply({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e.message }], isError: true });
        }
      }
      default:
        return error(-32601, `Method not found: ${msg.method}`);
    }
  }

  // ---- routes ----

  routes(app, { signed }) {
    const cors = (req, res, next) => {
      // Bearer tokens, not cookies: any origin may call (the MCP inspector runs in a browser).
      res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id" });
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    };
    const origin = (req) => (this.origin = this.site(req));
    const resourceMeta = (req) => ({ resource: `${origin(req)}/mcp`, authorization_servers: [this.origin], scopes_supported: ["books"], bearer_methods_supported: ["header"], resource_name: "Chytai", resource_documentation: `${this.origin}/mcp-howto` });
    app.use(["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/register", "/oauth/token", "/mcp"], cors);
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => res.json(resourceMeta(req)));
    app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"], (req, res) =>
      res.json({
        issuer: origin(req),
        authorization_endpoint: `${this.origin}/oauth/authorize`,
        token_endpoint: `${this.origin}/oauth/token`,
        registration_endpoint: `${this.origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["books"],
        client_id_metadata_document_supported: true,
        service_documentation: `${this.origin}/mcp-howto`,
      })
    );
    app.post("/oauth/register", (req, res) => {
      if (this.auth.tooMany(`oauth-register:${req.ip}`, 30)) return res.status(429).json({ error: "too_many_requests" });
      const r = this.register(req.body || {});
      res.status(r.error ? 400 : 201).json(r);
    });

    // The reader says yes or no. Anything wrong with the client or its return address is shown here, never
    // sent back to an address we cannot vouch for.
    const consentKey = (req, q) => sha(`consent:${req.token}:${q.client_id}:${q.redirect_uri}`);
    const checkAsk = async (q) => {
      const client = await this.findClient(q.client_id);
      if (!client) return { error: "Цей чат не зареєстрований у Chytai. Спробуйте підключити його ще раз." };
      const redirectUri = String(q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : ""));
      if (!client.redirect_uris.some((u) => sameRedirect(u, redirectUri))) return { error: "Чат просить повернути вас на адресу, якої ми не знаємо. Спробуйте підключити його ще раз." };
      return { client, redirectUri };
    };
    const back = (redirectUri, params) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
      return u.href;
    };
    app.get("/oauth/authorize", async (req, res) => {
      origin(req);
      const q = req.query;
      const ask = await checkAsk(q);
      if (ask.error) return res.status(400).send(this.pages.messagePage({ title: "Не вдалося підключити чат", text: ask.error, user: req.user }));
      if (q.response_type !== "code") return res.redirect(back(ask.redirectUri, { error: "unsupported_response_type", state: q.state, iss: this.origin }));
      if (!q.code_challenge || q.code_challenge_method !== "S256") return res.redirect(back(ask.redirectUri, { error: "invalid_request", error_description: "PKCE S256 required", state: q.state, iss: this.origin }));
      if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.set("Cache-Control", "no-store").send(this.pages.consentPage({ user: req.user, client: ask.client, host: new URL(ask.redirectUri).host || ask.redirectUri, fields: { client_id: q.client_id, redirect_uri: ask.redirectUri, code_challenge: q.code_challenge, state: q.state || "", key: consentKey(req, { ...q, redirect_uri: ask.redirectUri }) } }));
    });
    app.post("/oauth/authorize", signed, async (req, res) => {
      origin(req);
      const b = req.body || {};
      const ask = await checkAsk(b);
      if (ask.error || b.key !== consentKey(req, b)) return res.status(400).send(this.pages.messagePage({ title: "Не вдалося підключити чат", text: ask.error || "Спробуйте підключити чат ще раз.", user: req.user }));
      if (b.allow !== "1") return res.redirect(back(ask.redirectUri, { error: "access_denied", state: b.state, iss: this.origin }));
      const code = this.makeCode({ reader: req.user.id, client: ask.client, redirectUri: ask.redirectUri, challenge: String(b.code_challenge || "") });
      res.redirect(back(ask.redirectUri, { code, state: b.state, iss: this.origin }));
    });
    app.post("/oauth/token", (req, res) => {
      origin(req);
      const [status, body] = this.token(req.body || {});
      res.status(status).set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json(body);
    });

    // /settings/chats: how to connect, and who is connected.
    app.get("/mcp-howto", (req, res) => res.send(this.pages.chatsPage({ user: req.user, url: `${origin(req)}/mcp` })));
    app.get("/settings/chats", signed, (req, res) => res.send(this.pages.chatsSettingsPage({ user: req.user, url: `${origin(req)}/mcp`, grants: this.grants(req.user.id) })));
    app.post("/settings/chats/:id/revoke", signed, (req, res) => (this.revoke(req.user.id, req.params.id), res.redirect("/settings/chats")));

    const unauthorized = (req, res) =>
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource/mcp", scope="books"`)
        .json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Sign in to Chytai first" } });
    app.post("/mcp", (req, res) => {
      origin(req);
      const who = this.readerOf(req);
      if (!who) return unauthorized(req, res);
      const body = req.body;
      if (Array.isArray(body)) {
        const out = body.map((m) => this.call(who, m)).filter(Boolean);
        return out.length ? res.json(out) : res.sendStatus(202);
      }
      if (!body || typeof body !== "object") return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      const out = this.call(who, body);
      out ? res.json(out) : res.sendStatus(202);
    });
    // No stream from us; a browser that opens the address gets the page about it.
    app.get("/mcp", (req, res) => (/text\/html/.test(req.headers.accept || "") ? res.redirect("/mcp-howto") : res.set("Allow", "POST").sendStatus(405)));
    app.delete("/mcp", (req, res) => res.set("Allow", "POST").sendStatus(405));
  }
}

module.exports = { Mcp };
