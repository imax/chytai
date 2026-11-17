// «Увійти з Apple» in the phone app (Max, 2026-11-17: App Store wants it next to Google). The app's native sheet
// gives the page Apple's identity token (a JWT signed by Apple); the page sends it to /api/reader-login/apple and
// here we check it: Apple's signature (its public keys, kept a day), the issuer, our bundle id, not expired, a
// verified e-mail. The e-mail then works like a confirmed code, the same as Google's (google.js).
// APPLE_BUNDLE_IDS: the app ids the token may be for, comma-separated (the default is today's TestFlight app).
const crypto = require("crypto");

const KEYS_URL = process.env.APPLE_KEYS_URL || "https://appleid.apple.com/auth/keys"; // a stand-in for tests
const ISSUER = "https://appleid.apple.com";
const audiences = () => (process.env.APPLE_BUNDLE_IDS || "com.maxua.chytai").split(",").map((s) => s.trim()).filter(Boolean);

let keys = null; // { at, list }
async function appleKeys(fresh) {
  if (!fresh && keys && Date.now() - keys.at < 24 * 3600 * 1000) return keys.list;
  const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Apple keys ${res.status}`);
  keys = { at: Date.now(), list: (await res.json()).keys || [] };
  return keys.list;
}

// A token is good for one sign-in: one seen already is refused until it would have expired anyway.
const used = new Map(); // sha256 of the token -> its exp (ms)

// { email, sub } for a good token, { error } for one to tell the reader about; throws when Apple can't be reached.
async function verify(token) {
  token = String(token || "");
  const [h, p, s] = token.split(".");
  if (!h || !p || !s || token.length > 4000) return { error: "Apple не підтвердив вхід. Спробуйте ще раз." };
  let head, claims;
  try {
    head = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return { error: "Apple не підтвердив вхід. Спробуйте ще раз." };
  }
  if (head.alg !== "RS256") return { error: "Apple не підтвердив вхід. Спробуйте ще раз." };
  let jwk = (await appleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await appleKeys(true)).find((k) => k.kid === head.kid); // Apple turned its keys
  if (!jwk) return { error: "Apple не підтвердив вхід. Спробуйте ще раз." };
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok || claims.iss !== ISSUER || !audiences().includes(claims.aud) || !(claims.exp * 1000 > Date.now())) return { error: "Apple не підтвердив вхід. Спробуйте ще раз." };
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  for (const [k, exp] of used) if (exp < Date.now()) used.delete(k);
  if (used.has(hash)) return { error: "Цей вхід уже використано. Натисніть «Увійти з Apple» ще раз." };
  used.set(hash, claims.exp * 1000);
  if (!claims.email || String(claims.email_verified) === "false") return { error: "Apple не дав адресу пошти. Увійдіть поштою." };
  return { email: String(claims.email).toLowerCase(), sub: String(claims.sub || "") };
}

module.exports = { verify, audiences };
