// «Увійти через Google» on the site (Max, 2026-11-08: «спробуємо додати суто на сайті і подивимось чи будуть цим
// користуватися»). A plain OAuth redirect: no Google script on our pages, Google only sees the moment of signing in.
// We take the verified e-mail and the name, nothing else; the e-mail then works like a confirmed code, so a reader
// who signed up by mail can come in through Google with the same address and the other way round.
// Not in the phone apps: Google refuses sign-in inside an embedded browser (disallowed_useragent).
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; without them the button is not shown.
const crypto = require("crypto");

const ID = () => process.env.GOOGLE_CLIENT_ID || "";
const SECRET = () => process.env.GOOGLE_CLIENT_SECRET || "";
const AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth"; // stand-ins for tests
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const STATE_MS = 10 * 60 * 1000;

const on = (ua = "") => !!(ID() && SECRET()) && !/ChytaiApp|; wv\)/.test(ua);

// The state rides in a short cookie, signed with the site's ticket key: no table, and it survives a deploy.
function start({ next, redirectUri, key }) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const body = Buffer.from(JSON.stringify({ nonce, next, expires: Date.now() + STATE_MS })).toString("base64url");
  const cookie = `${body}.${crypto.createHmac("sha256", key).update(`google:${body}`).digest("base64url")}`;
  const url = `${AUTH_URL}?${new URLSearchParams({ client_id: ID(), redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state: nonce, prompt: "select_account" })}`;
  return { url, cookie };
}

// The state cookie back: { next } when it is ours, fresh and matches Google's `state`, else null.
function checkState(cookie, state, key) {
  const [body, sig] = String(cookie || "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(crypto.createHmac("sha256", key).update(`google:${body}`).digest("base64url"));
  if (want.length !== Buffer.from(sig).length || !crypto.timingSafeEqual(want, Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString());
    return s.expires >= Date.now() && s.nonce === String(state || "") ? { next: s.next || "" } : null;
  } catch {
    return null;
  }
}

// Trade Google's code for who it is. The id_token comes straight from Google over TLS, so its claims are
// checked but its signature need not be (Google's own guidance for the server-side flow).
async function finish({ code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: String(code || ""), client_id: ID(), client_secret: SECRET(), redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { id_token } = await res.json();
  const claims = JSON.parse(Buffer.from(String(id_token || "").split(".")[1] || "", "base64url").toString() || "{}");
  if (claims.aud !== ID() || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || !(claims.exp * 1000 > Date.now())) throw new Error("Google: чужий або застарілий id_token");
  if (!claims.email || claims.email_verified === false || claims.email_verified === "false") return { error: "Google не підтвердив пошту цього акаунта." };
  return { email: String(claims.email).toLowerCase(), name: String(claims.name || claims.given_name || "").slice(0, 60) };
}

module.exports = { on, start, checkState, finish };
