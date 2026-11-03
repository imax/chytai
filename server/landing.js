// The reader's landing (design «11a», Max, 2026-11-03): what the reader is, and signing in right here.
// No separate account: the e-mail and the code go to the site's sign-in (chytai.org.ua /api/reader-login/*,
// web/server.js), which answers with a one-time ticket that /auth trades for the account, as after the
// site's own sign-in. Works the same in a browser and in the phone apps (the page never leaves the reader).
// The words are Max's; he writes the copy himself. Paper and ink colours, Source Serif 4, Literata and Onest.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mark = `<b class="wm">Chytai</b>`;

// The explained passage: a reader screen in small, desktop (with the panel) and phone (with the sheet).
const PASSAGE = {
  one: "Отут мені й повернути б було на «неокласицизм», бо вчилися ми разом із М. К. Зеровим. Так я не схотів. Самі ж знаєте, неокласиком бути — силу треба терпіння. Читай Горація, Вергілія, Овідія та інших Гомерів.",
  two: "А бути сучасним письменником — значно легше. Нічого собі не читаєш, тільки пишеш. І всі задоволені. Так що наші з М. К. Зеровим стежки розійшлися.",
  sel: "Він — на Рим, а я — на Шенгерівку.",
  three: "Зіньківську школу закінчив я року 1903, з свідоцтвом, що маю право бути поштово-телеграфним чиновником дуже якогось високого (чотирнадцятого, чи що) розряду.",
};
const ARROW_UP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;

const deskMock = `<div class="mock desk-only" aria-hidden="true">
  <div class="mock-title">Моя автобіографія</div>
  <aside class="mock-panel">
    <div class="mock-head"><h3>Пояснення</h3><span class="kbd">Esc</span></div>
    <div class="mock-body">
      <p class="mock-quote" lang="uk">«${PASSAGE.sel}»</p>
      <p class="mock-text"><b>Жарт про два шляхи.</b> Микола Зеров — неокласик, перекладач римських поетів, тому «на Рим». Вишня протиставляє йому сільську Шенгерівку: замість античної класики — своє, сучасне й просте.</p>
    </div>
    <div class="mock-ask"><span>Уточнити питання…</span><i>${ARROW_UP}</i></div>
  </aside>
  <article class="mock-book" lang="uk"><p>${PASSAGE.one}</p><p>${PASSAGE.two} <mark>${PASSAGE.sel}</mark></p><p>${PASSAGE.three}</p></article>
</div>`;

const phoneMock = `<div class="mock-m phone-only" aria-hidden="true">
  <article class="mock-book" lang="uk"><p>${PASSAGE.two} <mark>${PASSAGE.sel}</mark></p></article>
  <div class="mock-sheet"><span class="grab"></span>
    <h3>Пояснення</h3>
    <p class="mock-text"><b>Жарт про два шляхи.</b> Микола Зеров — неокласик, перекладач римських поетів, тому «на Рим». Вишня протиставляє йому сільську Шенгерівку: своє, сучасне й просте.</p>
  </div>
</div>`;

// Three screens of paper books (src/renderer/paper.js): «Це вона?», the circled photo, the question card.
const bookRow = (color, title) => `<div class="pf-row"><span class="pf-cover" style="background:${color}"></span><span class="pf-name"><b>${title}</b><small>Остап Вишня</small></span><span class="pill">Додати</span></div>`;
const PAPER = [
  {
    title: "Додайте книжку",
    text: "Сфотографуйте обкладинку: Читалка прочитає назву й знайде книжку в каталозі Chytai.",
    screen: `<div class="scr">
      <div class="scr-shelf"><div class="scr-h">Мої книжки</div><div class="scr-covers"><span style="background:#3e5a4c"></span><span style="background:#c9bfae"></span><span style="background:#7a4b2a"></span></div></div>
      <div class="scr-dim"></div>
      <div class="scr-sheet"><div class="scr-h2">Це вона?</div>${bookRow("#7a2e22", "Моя автобіографія")}${bookRow("#2f4a5a", "Усмішки")}<span class="pf-new">Немає в списку: додати «Моя автобіографія», Остап Вишня</span></div>
    </div>`,
  },
  {
    title: "Обведіть незрозуміле",
    text: "Сфотографуйте сторінку й обведіть пальцем слово чи рядок. Без позначок питання буде про всю сторінку.",
    screen: `<div class="scr dark">
      <div class="cam-top"><span>Перезняти</span><b>Обведіть, що пояснити</b><span>Очистити</span></div>
      <div class="cam-photo"><div class="photo" lang="uk"><p>${PASSAGE.two} ${PASSAGE.sel}</p><p>Зіньківську школу закінчив я року 1903, з свідоцтвом, що маю право бути поштово-телеграфним чиновником дуже якогось високого <span class="ring">(чотирнадцятого, чи що)</span> розряду.</p><span class="pg">12</span></div></div>
      <div class="cam-go"><span class="pill">Пояснити обведене</span></div>
    </div>`,
  },
  {
    title: "Відповідь лишається",
    text: "Питання з відповідями зберігаються в книжці, їх можна уточнити.",
    screen: `<div class="scr">
      <div class="q-head"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1b1a17" stroke-width="1.8"><path d="m15 5-7 7 7 7"/></svg><span class="pf-cover sm" style="background:#7a2e22"></span><span class="pf-name"><b>Моя автобіографія</b><small>Остап Вишня · стор. 12</small></span></div>
      <div class="q-body">
        <div class="q-box"><span class="q-ph">Запитання про сторінку…</span><div class="q-acts"><span class="q-cam"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span class="pill">Запитати</span></div></div>
        <div class="q-list"><div class="q-h">Запитання</div>
          <div class="q-item"><div class="q-what"><span class="q-thumb"><i></i></span>Обведене на фото</div>
            <p><b>Чотирнадцятий розряд</b> — найнижчий клас у Табелі про ранги. Тож «дуже якогось високого» Вишня каже з іронією: таке свідоцтво давало право лише на найдрібнішу посаду.</p>
            <span class="q-date">стор. 12 · 3 листопада</span>
            <div class="mock-ask sm"><span>Уточнити…</span><i>${ARROW_UP}</i></div>
          </div>
        </div>
      </div>
    </div>`,
  },
];

// opts: { webUrl, mac, android, testimonials: [{ text, author }] }
function landingPage({ webUrl, mac = true, android = false, testimonials = [] }) {
  const apps = [mac && `<a href="${esc(webUrl)}/mac">Версія для Mac →</a>`, android && `<a href="${esc(webUrl)}/android">Версія для Android →</a>`].filter(Boolean);
  const footApps = [mac && `<a href="${esc(webUrl)}/mac">Для Mac</a>`, android && `<a href="${esc(webUrl)}/android">Для Android</a>`].filter(Boolean);
  const q = testimonials[0];
  const font = (f) => `<link rel="stylesheet" href="/node_modules/@fontsource-variable/${f}">`;
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai Reader · читалка з AI-поясненнями</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Електронна читалка з AI-поясненнями. Виділіть незрозуміле слово, назву чи складне місце, і AI пояснить його в контексті книжки.">
<meta name="theme-color" content="#f7f4ee">
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
${font("source-serif-4/opsz.css")}${font("source-serif-4/opsz-italic.css")}${font("literata/wght.css")}${font("onest/wght.css")}
<style>
  :root { color-scheme: light; --paper: #f7f4ee; --field: #fffdf9; --ink: #1b1a17; --ink2: #4a463f; --muted: #6b675f; --hint: #8a857b; --accent: #9a6418; --accent-h: #7f5212; --frame: #d6d0c4; --thin: #e4dfd5; --under: #c9bfae; --sel: #ecdcb8;
    --serif: "Source Serif 4 Variable", "Source Serif 4", Georgia, serif; --book: "Literata Variable", Literata, Georgia, serif; --ui: "Onest Variable", Onest, -apple-system, BlinkMacSystemFont, sans-serif; --shadow: 0 24px 60px -30px rgba(27,26,23,.45); }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--ui); -webkit-text-size-adjust: 100%; }
  a { color: inherit; text-decoration: none; } a:hover { color: var(--accent); }
  h1, h2, h3, p { margin: 0; }
  input, button { font: inherit; color: inherit; }
  input::placeholder { color: var(--hint); }
  .wm { font-family: var(--serif); font-weight: 600; color: var(--ink); }
  .phone-only { display: none !important; }
  .cap { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); font-weight: 500; }

  header { display: flex; align-items: center; gap: 24px; padding: 0 48px; height: 64px; border-bottom: 1px solid var(--ink); padding-top: env(safe-area-inset-top); box-sizing: content-box; }
  .brand { flex: 1; display: flex; align-items: baseline; gap: 8px; }
  .brand b { font-family: var(--serif); font-size: 24px; font-weight: 600; }
  .brand span { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  header a { font-size: 14px; color: var(--ink2); }

  .hero { display: grid; grid-template-columns: 440px minmax(0, 1fr); gap: 64px; padding: 72px 48px 80px; align-items: start; max-width: 1440px; margin: 0 auto; }
  .hero-l { display: flex; flex-direction: column; gap: 28px; padding-top: 12px; }
  .intro { display: flex; flex-direction: column; gap: 16px; }
  h1 { font-family: var(--serif); font-weight: 600; font-size: 54px; line-height: 1.04; letter-spacing: -.01em; text-wrap: balance; }
  .lead { font-size: 17px; line-height: 1.6; color: var(--ink2); text-wrap: pretty; }

  form { display: flex; flex-direction: column; gap: 12px; }
  form[hidden] { display: none; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field > span { font-size: 13px; color: var(--muted); }
  .field > span b { font-weight: 500; color: var(--ink); }
  .row { display: flex; gap: 10px; align-items: center; }
  .row input { flex: 1; min-width: 0; height: 48px; padding: 0 16px; border: 1px solid var(--ink); border-radius: 999px; background: var(--field); font-size: 16px; outline: none; }
  .row input:focus-visible { box-shadow: 0 0 0 3px rgba(154,100,24,.25); }
  .row input.code { font-size: 20px; letter-spacing: .3em; font-variant-numeric: tabular-nums; }
  .row button { height: 48px; padding: 0 22px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .row button.in { padding: 0 26px; }
  .row button:hover { background: var(--accent-h); } .row button:disabled { opacity: .6; cursor: default; }
  .note { font-size: 13px; line-height: 1.55; color: var(--muted); text-wrap: pretty; }
  .note.links { display: flex; gap: 14px; flex-wrap: wrap; }
  .note a, .done a { color: var(--accent); }
  .err { font-size: 14px; color: #b3261e; }
  .err:empty { display: none; }
  .done { font-size: 15px; color: var(--ink2); }

  .apps { display: flex; flex-direction: column; gap: 8px; }
  .apps > span { font-size: 13px; color: var(--muted); }
  .apps div { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; }
  .apps a { color: var(--ink2); border-bottom: 1px solid var(--under); padding-bottom: 2px; }
  .apps a:hover { color: var(--accent); }

  /* The reader in small (screen «10d») */
  .mock { height: 470px; display: grid; grid-template-columns: minmax(0, 1fr) 260px; grid-template-rows: 46px minmax(0, 1fr); background: var(--paper); border: 1px solid var(--frame); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow); }
  .mock-title { grid-column: 1 / 2; display: flex; justify-content: center; padding-top: 14px; border-bottom: 1px solid var(--thin); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--hint); }
  .mock-panel { grid-column: 2 / 3; grid-row: 1 / 3; border-left: 1px solid var(--ink); display: flex; flex-direction: column; }
  .mock-head { height: 46px; flex: 0 0 46px; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--ink); }
  .mock-head h3 { flex: 1; font-family: var(--serif); font-weight: 600; font-size: 17px; }
  .kbd { font-size: 10px; color: var(--hint); border: 1px solid var(--frame); border-radius: 4px; padding: 0 4px; }
  .mock-body { flex: 1; padding: 14px 16px 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .mock-quote { font-family: var(--serif); font-style: italic; font-size: 14px; line-height: 1.45; color: var(--ink2); }
  .mock-text { font-size: 13px; line-height: 1.6; text-wrap: pretty; } .mock-text b { font-weight: 600; }
  .mock-ask { padding: 10px 14px 14px 16px; display: flex; align-items: center; gap: 8px; }
  .mock-ask span { flex: 1; border-bottom: 1px solid var(--ink); padding: 6px 0; font-family: var(--serif); font-size: 14px; color: var(--hint); }
  .mock-ask i { width: 28px; height: 28px; border-radius: 50%; background: var(--thin); display: flex; align-items: center; justify-content: center; color: var(--hint); }
  .mock-ask.sm { padding: 0; } .mock-ask.sm span { font-family: var(--ui); font-size: 13px; padding: 5px 0; } .mock-ask.sm i { width: 26px; height: 26px; }
  .mock-book { grid-column: 1 / 2; padding: 22px 36px 0; font-family: var(--book); font-size: 16px; line-height: 27px; text-align: justify; hyphens: auto; -webkit-hyphens: auto; display: flex; flex-direction: column; gap: 9px; overflow: hidden; }
  .mock-book p { text-indent: 1.5em; }
  mark { background: var(--sel); color: inherit; -webkit-box-decoration-break: clone; box-decoration-break: clone; }

  .feats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px; padding: 0 48px 72px; max-width: 1440px; margin: 0 auto; }
  .feats > div { border-top: 1px solid var(--ink); padding-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .feats p { font-size: 15px; line-height: 1.6; color: var(--ink2); text-wrap: pretty; }

  .paper { margin: 0 48px; border-top: 1px solid var(--ink); padding: 56px 0 88px; display: flex; flex-direction: column; gap: 44px; }
  .paper-head { display: grid; grid-template-columns: 440px minmax(0, 1fr); gap: 64px; align-items: start; }
  .paper-head > div { display: flex; flex-direction: column; gap: 14px; }
  h2 { font-family: var(--serif); font-weight: 600; font-size: 40px; line-height: 1.08; text-wrap: balance; }
  .paper-head p { font-size: 17px; line-height: 1.6; color: var(--ink2); text-wrap: pretty; max-width: 600px; padding-top: 30px; }
  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px; }
  .step { display: flex; flex-direction: column; gap: 18px; }
  .step-t { display: flex; flex-direction: column; gap: 6px; }
  .step-t h3 { display: flex; gap: 8px; align-items: baseline; font-size: 16px; font-weight: 600; } .step-t h3 span { color: var(--accent); }
  .step-t p { font-size: 15px; line-height: 1.55; color: var(--ink2); text-wrap: pretty; }

  .scr { height: 520px; position: relative; display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--frame); border-radius: 14px; overflow: hidden; box-shadow: var(--shadow); }
  .scr.dark { background: var(--ink); }
  .scr-shelf { padding: 18px 16px; display: flex; flex-direction: column; gap: 14px; }
  .scr-h { font-family: var(--serif); font-weight: 600; font-size: 22px; }
  .scr-covers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; } .scr-covers span { aspect-ratio: 2 / 3; border-radius: 3px; }
  .scr-dim { position: absolute; inset: 0; background: rgba(27,26,23,.45); }
  .scr-sheet { position: absolute; left: 12px; right: 12px; top: 96px; background: var(--paper); border-radius: 14px; padding: 18px 16px 16px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 20px 50px -20px rgba(0,0,0,.5); }
  .scr-h2 { font-family: var(--serif); font-weight: 600; font-size: 21px; }
  .pf-row { display: flex; align-items: center; gap: 12px; }
  .pf-cover { flex: 0 0 36px; width: 36px; height: 52px; border-radius: 3px; box-shadow: inset 3px 0 0 rgba(0,0,0,.18); }
  .pf-cover.sm { flex: 0 0 24px; width: 24px; height: 34px; }
  .pf-name { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
  .pf-name b, .pf-name small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pf-name b { font-size: 14px; font-weight: 500; } .pf-name small { font-size: 12.5px; color: var(--muted); }
  .pill { flex: 0 0 auto; display: flex; align-items: center; height: 32px; padding: 0 14px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 13px; font-weight: 500; white-space: nowrap; }
  .pf-new { font-size: 13px; line-height: 1.45; color: var(--accent); text-wrap: pretty; }
  .cam-top { padding: 16px; display: flex; align-items: center; gap: 8px; color: var(--paper); font-size: 13px; }
  .cam-top span { flex: 1; color: #cfc8ba; } .cam-top span:last-child { text-align: right; } .cam-top b { font-size: 14px; font-weight: 400; }
  .cam-photo { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 18px; }
  .photo { width: 100%; transform: rotate(-1.2deg); background: linear-gradient(160deg, #efe6d3, #d9ccb1); box-shadow: 0 12px 30px rgba(0,0,0,.55); padding: 22px 18px 14px; font-family: var(--book); font-size: 11.5px; line-height: 18px; color: #2a2620; text-align: justify; hyphens: auto; -webkit-hyphens: auto; display: flex; flex-direction: column; gap: 6px; }
  .photo p { text-indent: 1.5em; }
  .ring { display: inline-block; white-space: nowrap; text-indent: 0; border: 2.5px solid rgba(214,40,30,.85); border-radius: 50%; padding: 1px 6px; margin: -4px -8px; transform: rotate(-3deg); }
  .pg { text-align: center; font-size: 10px; color: #6b6152; margin-top: 6px; }
  .cam-go { padding: 14px 16px 18px; display: flex; justify-content: center; }
  .q-head { height: 54px; flex: 0 0 54px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--ink); }
  .q-head .pf-name { line-height: 1.25; } .q-head .pf-name b { font-size: 13.5px; font-weight: 600; } .q-head .pf-name small { font-size: 11.5px; }
  .q-body { padding: 14px 14px 0; display: flex; flex-direction: column; gap: 16px; }
  .q-box { border: 1px solid var(--frame); border-radius: 12px; background: var(--field); padding: 10px 10px 8px; display: flex; flex-direction: column; gap: 10px; }
  .q-ph { font-size: 13.5px; line-height: 1.45; color: var(--hint); min-height: 38px; }
  .q-acts { display: flex; align-items: center; justify-content: space-between; }
  .q-cam { width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--frame); display: flex; align-items: center; justify-content: center; color: var(--ink2); }
  .q-list { display: flex; flex-direction: column; gap: 10px; }
  .q-h { font-family: var(--serif); font-weight: 600; font-size: 16px; }
  .q-item { border-top: 1px solid var(--thin); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .q-item p { font-size: 13.5px; line-height: 1.55; text-wrap: pretty; } .q-item p b { font-weight: 600; }
  .q-what { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 500; }
  .q-thumb { flex: 0 0 26px; height: 34px; border-radius: 3px; background: linear-gradient(160deg, #efe6d3, #d9ccb1); position: relative; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .q-thumb i { position: absolute; left: 5px; top: 16px; width: 15px; height: 7px; border: 1.5px solid rgba(214,40,30,.85); border-radius: 50%; }
  .q-date { font-size: 12px; color: var(--hint); }

  .quote { padding: 0 48px 80px; display: grid; grid-template-columns: 440px minmax(0, 1fr); gap: 64px; max-width: 1440px; margin: 0 auto; }
  .quote > span { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--hint); padding-top: 10px; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
  blockquote { margin: 0; font-family: var(--serif); font-size: 28px; line-height: 1.35; text-wrap: pretty; }
  figcaption { font-size: 14px; color: var(--muted); }

  footer { border-top: 1px solid var(--ink); padding: 18px 48px calc(18px + env(safe-area-inset-bottom)); display: flex; gap: 24px; font-size: 13px; color: var(--muted); }
  footer > span { flex: 1; } footer > span a { color: var(--ink); }
  footer .apps-f { display: none; }

  @media (min-width: 1441px) { .paper { max-width: 1344px; margin: 0 auto; } }
  @media (max-width: 1100px) and (min-width: 761px) {
    .hero { grid-template-columns: minmax(0, 1fr); } .hero-l { max-width: 560px; }
    .paper-head, .quote { grid-template-columns: minmax(0, 1fr); gap: 16px; } .paper-head p { padding-top: 0; }
    .steps { gap: 20px; }
  }

  /* Phone (design 390 px) */
  @media (max-width: 760px) {
    .desk-only { display: none !important; } .phone-only { display: block !important; }
    header { height: 54px; padding: env(safe-area-inset-top) 20px 0; gap: 8px; }
    .brand b { font-size: 22px; } header a { font-size: 13px; }
    .hero { display: block; padding: 32px 20px 0; }
    .hero-l { gap: 22px; padding-top: 0; }
    .intro { gap: 12px; }
    h1 { font-size: 38px; line-height: 1.05; }
    .lead { font-size: 16px; line-height: 1.55; }
    form { gap: 10px; }
    .row { flex-direction: column; align-items: stretch; }
    .row input, .row button { height: 50px; flex: none; } .row input { padding: 0 18px; } .row button { font-size: 16px; }
    .row input.code { text-align: center; }
    .field { gap: 10px; }
    .note { line-height: 1.5; }
    .note .pw { display: none; }
    .note.links { flex-direction: column; gap: 0; } .note.links a { align-self: flex-start; padding: 6px 0; }
    .mock-m { margin: 32px 20px 0; height: 380px; position: relative; background: var(--paper); border: 1px solid var(--frame); border-radius: 12px; overflow: hidden; }
    .mock-m .mock-book { padding: 20px 20px 0; line-height: 26px; display: block; }
    .mock-sheet { position: absolute; left: 0; right: 0; bottom: 0; height: 206px; background: var(--paper); border-top: 1px solid var(--ink); border-radius: 14px 14px 0 0; box-shadow: 0 -12px 30px -16px rgba(27,26,23,.35); padding: 7px 18px 0; display: flex; flex-direction: column; gap: 8px; }
    .grab { align-self: center; width: 36px; height: 4px; border-radius: 2px; background: var(--frame); margin-bottom: 8px; }
    .mock-sheet h3 { font-family: var(--serif); font-weight: 600; font-size: 18px; }
    .mock-sheet .mock-text { font-size: 13.5px; line-height: 1.55; }
    .feats { display: flex; flex-direction: column; gap: 22px; padding: 36px 20px 0; }
    .feats > div { padding-top: 12px; gap: 6px; } .feats p { line-height: 1.55; }
    .paper { margin: 44px 20px 0; padding: 24px 0 0; gap: 12px; }
    .paper-head { display: flex; flex-direction: column; gap: 12px; } .paper-head > div { gap: 12px; }
    h2 { font-size: 28px; line-height: 1.1; }
    .paper-head p { font-size: 15.5px; line-height: 1.55; padding-top: 0; }
    .steps { margin: 10px -20px 0; padding: 0 20px 8px; display: flex; gap: 14px; overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding: 0 20px; }
    .step { flex: 0 0 264px; scroll-snap-align: start; gap: 14px; }
    .scr { height: 450px; }
    .step-t h3 { font-size: 15px; } .step-t p { font-size: 14px; }
    .quote { display: block; padding: 0; margin: 40px 20px 0; }
    .quote > span { display: none; }
    blockquote { font-size: 22px; }
    footer { flex-direction: column; gap: 10px; margin-top: 40px; padding: 18px 20px calc(24px + env(safe-area-inset-bottom)); }
    footer .apps-f { display: flex; gap: 16px; } footer .desk-l { display: none; }
  }
</style></head>
<body>
<header><div class="brand"><b>Chytai</b><span>Читалка</span></div><a href="${esc(webUrl)}">Chytai.org.ua ↗</a></header>
<main>
<section class="hero">
  <div class="hero-l">
    <div class="intro">
      <h1>Chytai Reader</h1>
      <p class="lead">Електронна читалка з AI-поясненнями. Виділіть незрозуміле слово, назву чи складне місце, і AI пояснить його в контексті книжки.</p>
    </div>
    <div id="signin" data-web="${esc(webUrl)}">
      <form id="f-email" novalidate>
        <label class="field"><span class="desk-only">Пошта</span>
          <div class="row"><input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="olena@ukr.net" data-ph-phone="Ваша пошта"><button type="submit">Отримати код</button></div>
        </label>
        <p class="err" role="alert"></p>
        <p class="note">Акаунт спільний з ${mark}.org.ua. Якщо ви вже там є, вкажіть ту саму пошту.<span class="pw"> Пароля немає, код для входу приходить на пошту.</span></p>
      </form>
      <form id="f-code" hidden>
        <label class="field"><span>Код з листа, надіслали на <b class="shown"></b></span>
          <div class="row"><input class="code" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="······"><button type="submit" class="in">Увійти</button></div>
        </label>
        <p class="err" role="alert"></p>
        <p class="note links"><span class="desk-only">Лист іде до хвилини, перевірте й «Спам».</span><a href="#" data-back>Інша пошта</a></p>
      </form>
      <form id="f-name" hidden>
        <label class="field"><span>Ім'я, як показувати іншим</span>
          <div class="row"><input name="name" required maxlength="60" autocomplete="name" placeholder="Марія Коваль"><button type="submit">Готово</button></div>
        </label>
        <p class="err" role="alert"></p>
      </form>
      <p class="done" id="f-done" hidden>Готово. Відкриваємо «Мої книжки»…</p>
    </div>
    ${apps.length ? `<div class="apps"><span>Застосунки для комп'ютера й телефона</span><div>${apps.join("")}</div></div>` : ""}
  </div>
  ${deskMock}
</section>
${phoneMock}
<section class="feats">
  <div><span class="cap">Завантажуйте книжки</span><p>Завантажуйте файл з телефона, компʼютера чи акаунта в магазині. Підтримуємо EPUB, PDF, MOBI.</p></div>
  <div><span class="cap">AI-пояснення, переклад і нотатки</span><p>Запитуйте про незрозумілі фрази, назви або складні місця, зберігайте цікаве собі в нотатки.</p></div>
  <div><span class="cap">Інтеграція з ${mark}</span><p>Спільний акаунт, полиця і пошук.</p></div>
</section>
<section class="paper">
  <div class="paper-head">
    <div><span class="cap">Додавайте паперові книжки</span><h2>Паперові й електронні книжки в одному місці</h2></div>
    <p><span class="desk-only">Паперова книжка стоїть поруч з електронними, тільки без файлу. Сфотографуйте сторінку, і AI пояснить незрозуміле місце так само, як в електронній.</span><span class="phone-only">Паперова книжка стоїть поруч з електронними. Сфотографуйте сторінку, і AI пояснить незрозуміле місце.</span></p>
  </div>
  <div class="steps">
    ${PAPER.map((s, i) => `<div class="step"><div aria-hidden="true">${s.screen}</div><div class="step-t"><h3><span>${i + 1}</span>${s.title}</h3><p>${s.text}</p></div></div>`).join("")}
  </div>
</section>
${q ? `<section class="quote"><span>Що кажуть користувачі</span><figure><blockquote>«${esc(q.text)}»</blockquote>${q.author ? `<figcaption>— ${esc(q.author)}</figcaption>` : ""}</figure></section>` : ""}
</main>
<footer>
  <span>Частина <a href="${esc(webUrl)}">${mark}.org.ua</a></span>
  ${footApps.length ? `<span class="apps-f">${footApps.join("")}</span>` : ""}
  <a class="desk-l" href="${esc(webUrl)}/privacy">Приватність</a>
  <a class="desk-l" href="mailto:ischenko@gmail.com">Написати нам</a>
</footer>
<script>
(() => {
  const box = document.getElementById("signin");
  const web = box.dataset.web;
  const forms = { email: document.getElementById("f-email"), code: document.getElementById("f-code"), name: document.getElementById("f-name") };
  const done = document.getElementById("f-done");
  const emailInput = forms.email.elements.email;
  let email = "", signup = "";
  const phone = matchMedia("(max-width: 760px)");
  const ph = () => (emailInput.placeholder = phone.matches ? emailInput.dataset.phPhone : "olena@ukr.net");
  ph(); phone.addEventListener?.("change", ph);
  const show = (step) => {
    for (const [k, f] of Object.entries(forms)) { f.hidden = k !== step; f.querySelector(".err").textContent = ""; }
    done.hidden = step !== "in";
    const f = forms[step];
    if (f) setTimeout(() => f.querySelector("input").focus(), 0);
  };
  const call = async (form, what, body) => {
    const err = form.querySelector(".err");
    const btn = form.querySelector("button");
    err.textContent = "";
    btn.disabled = true;
    try {
      const res = await fetch(web + "/api/reader-login/" + what, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || "Сайт chytai.org.ua зараз не відповідає. Спробуйте ще раз за хвилину.");
      return data;
    } catch (e) {
      err.textContent = e instanceof TypeError ? "Сайт chytai.org.ua зараз не відповідає. Спробуйте ще раз за хвилину." : e.message;
      return null;
    } finally {
      btn.disabled = false;
    }
  };
  const enter = (ticket) => { show("in"); location.href = "/auth?ticket=" + encodeURIComponent(ticket); };
  forms.email.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!emailInput.checkValidity()) return emailInput.reportValidity();
    const r = await call(forms.email, "email", { email: emailInput.value });
    if (!r) return;
    email = r.email || emailInput.value.trim();
    forms.code.querySelector(".shown").textContent = email;
    forms.code.elements.code.value = "";
    show("code");
  });
  forms.code.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await call(forms.code, "code", { email, code: forms.code.elements.code.value });
    if (!r) return;
    if (r.ticket) return enter(r.ticket);
    signup = r.signup;
    show("name");
  });
  forms.name.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await call(forms.name, "signup", { signup, name: forms.name.elements.name.value });
    if (r && r.ticket) enter(r.ticket);
  });
  forms.code.querySelector("[data-back]").addEventListener("click", (e) => { e.preventDefault(); show("email"); });
})();
</script>
</body></html>`;
}

module.exports = { landingPage };
