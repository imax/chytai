// The reader's landing (Max, 2026-11-04): one compact screen. What it is, signing in or up right here (e-mail,
// code, a name for a new address: the same steps as in the phone apps, through the site's /api/reader-login/*),
// and the real reader at work: a looping recording of selecting a word, the explanation, «В нотатки».
// The recordings are build/landing-{desk,phone}.mp4 (made with Playwright from a local reader). Copy is Max's.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mark = `<b class="wm">Chytai</b>`;

// opts: { webUrl, mac, android, testimonials: [{ text, author }] }
function landingPage({ webUrl, mac = true, android = true, testimonials = [] }) {
  const apps = [mac && `<a href="${esc(webUrl)}/mac">Для Mac</a>`, android && `<a href="${esc(webUrl)}/android">Для Android</a>`].filter(Boolean);
  const q = testimonials[0];
  const font = (f) => `<link rel="stylesheet" href="/node_modules/@fontsource-variable/${f}">`;
  const video = (name, label) => `<video data-src="/landing-${name}.mp4" poster="/landing-${name}-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="${label}"></video>`;
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Читалка з AI-поясненнями · Chytai</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Виділіть незрозуміле слово, назву чи складне місце, і AI пояснить його в контексті книжки.">
<meta name="theme-color" content="#f7f4ee">
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
${font("source-serif-4/opsz.css")}${font("onest/wght.css")}
<style>
  :root { color-scheme: light; --paper: #f7f4ee; --field: #fffdf9; --ink: #1b1a17; --ink2: #4a463f; --muted: #6b675f; --hint: #8a857b; --accent: #9a6418; --accent-h: #7f5212; --frame: #d6d0c4; --under: #c9bfae;
    --serif: "Source Serif 4 Variable", "Source Serif 4", Georgia, serif; --ui: "Onest Variable", Onest, -apple-system, BlinkMacSystemFont, sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--ui); -webkit-text-size-adjust: 100%; }
  body { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
  a { color: inherit; text-decoration: none; } a:hover { color: var(--accent); }
  h1, p { margin: 0; }
  input, button { font: inherit; color: inherit; }
  input::placeholder { color: var(--hint); }
  .wm { font-family: var(--serif); font-weight: 600; color: var(--ink); }

  header { display: flex; align-items: baseline; gap: 8px; padding: calc(20px + env(safe-area-inset-top)) 48px 0; }
  header .wm { font-size: 24px; }
  header span { flex: 1; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  header a { font-size: 14px; color: var(--ink2); }

  main { flex: 1; display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 56px; align-items: center; padding: 24px 48px; max-width: 1360px; width: 100%; margin: 0 auto; }
  .side { display: flex; flex-direction: column; gap: 26px; }
  h1 { font-family: var(--serif); font-weight: 600; font-size: 50px; line-height: 1.04; letter-spacing: -.01em; text-wrap: balance; }
  .lead { margin-top: 14px; font-size: 17px; line-height: 1.6; color: var(--ink2); text-wrap: pretty; }

  form { display: flex; flex-direction: column; gap: 10px; }
  form[hidden], .done[hidden] { display: none; }
  .lab { font-size: 13px; color: var(--muted); } .lab b { font-weight: 500; color: var(--ink); }
  .row { display: flex; gap: 10px; }
  .row input { flex: 1; min-width: 0; height: 48px; padding: 0 18px; border: 1px solid var(--ink); border-radius: 999px; background: var(--field); font-size: 16px; outline: none; }
  .row input:focus-visible { box-shadow: 0 0 0 3px rgba(154,100,24,.25); }
  .row input.code { font-size: 20px; letter-spacing: .3em; font-variant-numeric: tabular-nums; }
  .row button { height: 48px; padding: 0 22px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .row button:hover { background: var(--accent-h); } .row button:disabled { opacity: .6; cursor: default; }
  .note { font-size: 13px; line-height: 1.55; color: var(--muted); text-wrap: pretty; }
  .note a, .done { color: var(--accent); }
  .err { font-size: 14px; color: #b3261e; } .err:empty { display: none; }
  .done { font-size: 15px; }

  .more { display: flex; flex-direction: column; gap: 18px; }
  .apps { display: flex; gap: 20px; font-size: 14px; }
  .apps a { color: var(--ink2); border-bottom: 1px solid var(--under); padding-bottom: 2px; }
  figure { margin: 0; padding-left: 14px; border-left: 2px solid var(--under); }
  blockquote { margin: 0; font-family: var(--serif); font-size: 16px; line-height: 1.45; color: var(--ink2); text-wrap: pretty; }
  figcaption { margin-top: 4px; font-size: 13px; color: var(--hint); }

  /* The reader at work: the computer window, the phone in front of it */
  .stage { position: relative; padding: 0 0 36px; }
  .win { margin-left: 110px; border: 1px solid var(--frame); border-radius: 12px; overflow: hidden; background: var(--paper); box-shadow: 0 30px 70px -34px rgba(27,26,23,.5); }
  .win i { display: flex; gap: 6px; height: 26px; align-items: center; padding: 0 12px; border-bottom: 1px solid #e4dfd5; background: #efeae1; }
  .win i b { width: 9px; height: 9px; border-radius: 50%; background: #d6d0c4; }
  .win video { display: block; width: 100%; aspect-ratio: 8 / 5; object-fit: cover; }
  .phone { position: absolute; left: 0; bottom: 0; width: 200px; padding: 7px; border-radius: 34px; background: #1b1a17; box-shadow: 0 30px 60px -24px rgba(27,26,23,.6); }
  .phone video { display: block; width: 100%; aspect-ratio: 390 / 844; object-fit: cover; border-radius: 27px; background: var(--paper); }

  footer { display: flex; gap: 24px; padding: 14px 48px calc(14px + env(safe-area-inset-bottom)); font-size: 13px; color: var(--muted); }
  footer > span { flex: 1; } footer > span a { color: var(--ink); }

  @media (max-width: 1100px) and (min-width: 761px) { main { grid-template-columns: 340px minmax(0, 1fr); gap: 36px; } h1 { font-size: 42px; } .phone { width: 160px; } .win { margin-left: 90px; } }
  @media (max-height: 760px) and (min-width: 761px) { h1 { font-size: 42px; } .side { gap: 20px; } }

  /* Phone */
  @media (max-width: 760px) {
    header { padding: calc(14px + env(safe-area-inset-top)) 20px 0; } header .wm { font-size: 22px; } header a { font-size: 13px; }
    main { display: flex; flex-direction: column; align-items: stretch; gap: 28px; padding: 22px 20px 8px; }
    .side { display: contents; }
    .intro { order: 1; } #signin { order: 2; } .stage { order: 3; } .more { order: 4; }
    h1 { font-size: 34px; line-height: 1.06; }
    .lead { margin-top: 10px; font-size: 16px; line-height: 1.55; }
    .row { flex-direction: column; }
    .row input, .row button { flex: none; height: 50px; } .row button { font-size: 16px; }
    .row input.code { text-align: center; }
    .stage { padding: 0; display: flex; justify-content: center; }
    .win { display: none; }
    .phone { position: static; width: min(280px, 78vw); }
    footer { flex-wrap: wrap; gap: 8px 18px; padding: 18px 20px calc(18px + env(safe-area-inset-bottom)); }
    footer > span { flex-basis: 100%; }
  }
</style></head>
<body>
<header>${mark}<span>Читалка</span><a href="${esc(webUrl)}">Chytai.org.ua ↗</a></header>
<main>
  <div class="side">
    <div class="intro">
      <h1>Читалка з AI‑поясненнями</h1>
      <p class="lead">Виділіть незрозуміле слово, назву чи складне місце, і AI пояснить його в контексті книжки.</p>
    </div>
    <div id="signin" data-web="${esc(webUrl)}">
      <form id="f-email" novalidate>
        <div class="row"><input type="email" name="email" enterkeyhint="send" required autocomplete="email" inputmode="email" autocapitalize="off" placeholder="Ваша пошта" aria-label="Пошта"><button type="submit">Отримати код</button></div>
        <p class="err" role="alert"></p>
        <p class="note">Пароля немає: код для входу прийде на пошту. Акаунт спільний з ${mark}.org.ua.</p>
      </form>
      <form id="f-code" hidden>
        <p class="lab">Код надіслали на <b class="shown"></b></p>
        <div class="row"><input class="code" name="code" enterkeyhint="go" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="······" aria-label="Код"><button type="submit">Увійти</button></div>
        <p class="err" role="alert"></p>
        <p class="note">Лист іде до хвилини, перевірте й «Спам». <a href="#" data-back>Інша пошта</a></p>
      </form>
      <form id="f-name" hidden>
        <p class="lab">Ви тут уперше. Як вас звати?</p>
        <div class="row"><input name="name" enterkeyhint="done" required maxlength="60" autocomplete="name" placeholder="Ім'я" aria-label="Ім'я"><button type="submit">Готово</button></div>
        <p class="err" role="alert"></p>
      </form>
      <p class="done" id="f-done" hidden>Відкриваю ваші книжки…</p>
    </div>
    <div class="more">
      ${q ? `<figure><blockquote>«${esc(q.text)}»</blockquote>${q.author ? `<figcaption>— ${esc(q.author)}</figcaption>` : ""}</figure>` : ""}
      ${apps.length ? `<div class="apps">${apps.join("")}</div>` : ""}
    </div>
  </div>
  <div class="stage">
    <div class="win"><i><b></b><b></b><b></b></i>${video("desk", "Читалка на комп'ютері: виділене слово, пояснення, нотатка")}</div>
    <div class="phone">${video("phone", "Читалка на телефоні: виділене слово, пояснення, нотатка")}</div>
  </div>
</main>
<footer>
  <span>Частина <a href="${esc(webUrl)}">${mark}.org.ua</a></span>
  <a href="${esc(webUrl)}/privacy">Приватність</a>
  <a href="mailto:ischenko@gmail.com">Написати нам</a>
</footer>
<script>
(function () {
  // The recordings: only the one that shows (no computer window on a phone); a still picture for reduced motion.
  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  [].forEach.call(document.querySelectorAll("video[data-src]"), function (v) {
    if (still || !v.offsetParent) return;
    v.src = v.dataset.src;
  });
  var web = document.getElementById("signin").dataset.web;
  var forms = { email: document.getElementById("f-email"), code: document.getElementById("f-code"), name: document.getElementById("f-name") };
  var done = document.getElementById("f-done");
  var email = "", signup = "";
  // Enter sends the step, whatever the browser does by itself (a reader on an iPhone, 2026-11-04: Enter after the
  // e-mail did nothing). While a step is on its way the button is off, and Enter waits too.
  Object.keys(forms).forEach(function (k) {
    var f = forms[k];
    f.querySelector("input").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (!f.querySelector("button").disabled) f.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  });
  var DOWN = "Сайт chytai.org.ua зараз не відповідає. Спробуйте ще раз за хвилину.";
  function show(step) {
    Object.keys(forms).forEach(function (k) { forms[k].hidden = k !== step; forms[k].querySelector(".err").textContent = ""; });
    done.hidden = step !== "in";
    if (forms[step]) setTimeout(function () { forms[step].querySelector("input").focus(); }, 0);
  }
  function call(form, what, body) {
    var err = form.querySelector(".err"), btn = form.querySelector("button");
    err.textContent = ""; btn.disabled = true; var label = btn.textContent; btn.textContent = "Хвилинку…";
    return fetch(web + "/api/reader-login/" + what, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok || d.error) throw new Error(d.error || DOWN); return d; }); })
      .catch(function (e) { err.textContent = e instanceof TypeError ? DOWN : e.message; return null; })
      .then(function (d) { btn.disabled = false; btn.textContent = label; return d; });
  }
  function enter(ticket) { show("in"); location.href = "/auth?ticket=" + encodeURIComponent(ticket); }
  forms.email.addEventListener("submit", function (e) {
    e.preventDefault();
    var input = forms.email.elements.email;
    if (!input.value.trim() || !input.checkValidity()) { forms.email.querySelector(".err").textContent = "Вкажіть пошту, наприклад olena@ukr.net."; return; }
    call(forms.email, "email", { email: input.value }).then(function (r) {
      if (!r) return;
      email = r.email || input.value.trim();
      forms.code.querySelector(".shown").textContent = email;
      forms.code.elements.code.value = "";
      show("code");
    });
  });
  forms.code.addEventListener("submit", function (e) {
    e.preventDefault();
    call(forms.code, "code", { email: email, code: forms.code.elements.code.value }).then(function (r) {
      if (!r) return;
      if (r.ticket) return enter(r.ticket);
      signup = r.signup; show("name");
    });
  });
  forms.name.addEventListener("submit", function (e) {
    e.preventDefault();
    call(forms.name, "signup", { signup: signup, name: forms.name.elements.name.value }).then(function (r) { if (r && r.ticket) enter(r.ticket); });
  });
  forms.code.querySelector("[data-back]").addEventListener("click", function (e) { e.preventDefault(); show("email"); });
})();
</script>
</body></html>`;
}

module.exports = { landingPage };
