// «Статті» (Max, 2026-11-08, codename «Chytai shorts»): essays and long articles readers bring in by link, read right
// on the site, with the AI explanations other readers asked for shown in the margin. A section of its own, not
// books: different page, different «what next», a reader who reads «по роботі».
//
// MOCKUP: the data comes from DATA_DIR/web/articles/*.json (not in git: article texts are other people's work).
const fs = require("fs");
const path = require("path");
const pages = require("./pages");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = esc;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

const TOPICS = ["ШІ", "Економіка", "Лідерство", "Суспільство", "Технології", "Філософія"];

class Articles {
  constructor(dir) {
    this.dir = path.join(dir, "articles");
  }
  all() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"))).sort((a, b) => String(b.added).localeCompare(String(a.added)));
  }
  get(slug) {
    return this.all().find((a) => a.slug === slug) || null;
  }
}

const minutes = (a) => `${a.minutes} хв`;
const notesOf = (a) => (a.blocks || []).reduce((n, b) => n + (b.notes || []).length, 0);

function row(a) {
  const n = notesOf(a);
  const meta = [esc(a.author || "автор не вказаний"), esc(a.source || ""), minutes(a), n ? count(n, "пояснення", "пояснення", "пояснень") : ""].filter(Boolean).join(" · ");
  return `<div class="arow">
  <a class="t" href="/articles/${attr(a.slug)}"><b>${esc(a.title)}</b></a>
  ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
  <p class="m">${a.topics?.length ? `<span class="topic">${a.topics.map(esc).join(", ")}</span> · ` : ""}${meta}</p>
  <button type="button" class="later${a.later ? " on" : ""}" title="Прочитати пізніше" aria-label="Прочитати пізніше">${a.later ? "✓ У черзі" : "+ Пізніше"}</button>
</div>`;
}

function indexPage({ user, list }) {
  const later = list.filter((a) => a.later);
  const add = user
    ? `<form class="a-add" onsubmit="return false"><input type="url" placeholder="Посилання на статтю" aria-label="Посилання на статтю"><button class="btn primary">Додати</button></form>`
    : `<a class="btn primary" href="/login?next=/articles">Додати статтю</a>`;
  const body = `
<section class="page-head a-head">
  <div>
    <h1>Статті</h1>
    <p class="lead">Есе й довгі тексти.</p>
  </div>
  <div class="head-act">${add}</div>
</section>
<div class="a-index">
${user && later.length ? `<div class="label"><h2>Прочитати пізніше</h2></div><div class="arows">${later.map(row).join("")}</div>` : ""}
<div class="label"><h2>Усі статті</h2><div class="aside">${list.length}</div></div>
<div class="a-topics"><a class="chip on">Усі</a>${TOPICS.map((t) => `<a class="chip">${t}</a>`).join("")}</div>
<div class="arows">${list.map(row).join("")}</div>
</div>`;
  return pages.layout({ title: "Статті", body, user, path: "/articles", canonical: "/articles", description: "Есе й довгі статті, які читачі принесли в Chytai." });
}

// The explained words in a block get a dotted line; the margin holds what was explained, with how many asked.
function markBlock(b) {
  let html = b.html;
  (b.notes || []).forEach((n, i) => {
    const at = html.indexOf(n.q);
    if (at >= 0) html = `${html.slice(0, at)}<mark class="ex" data-n="${i}">${n.q}</mark>${html.slice(at + n.q.length)}`;
  });
  return html;
}
const note = (n, i) => `<div class="anote" data-n="${i}">
  <p class="nq">${esc(n.q)}</p>
  <p class="nt">${esc(n.text)}</p>
  <p class="nm">${n.asked > 1 ? `питали ${count(n.asked, "читач", "читачі", "читачів")}` : "питав 1 читач"}${n.ask ? ` · <a href="#">ще питання</a>` : ""}</p>
</div>`;

function articlePage({ user, a, next = [], open = -1 }) {
  const hint = user
    ? `<p class="a-hint">Виділіть слово чи речення, щоб спитати своє.</p>`
    : `<p class="a-hint">Пояснення, які попросили інші читачі. <a href="/login?next=/articles/${attr(a.slug)}">Увійдіть</a>, щоб спитати своє.</p>`;
  const blocks = a.blocks.map((b, i) => {
    const tag = b.tag || "p";
    const inner = markBlock(b);
    const notes = (i === 0 ? hint : "") + (b.notes || []).map(note).join("");
    return `<div class="arow-b${i === open ? " open" : ""}" id="p${i + 1}"><div class="txt"><a class="pl" href="#p${i + 1}" title="Посилання на абзац">¶</a><${tag}>${inner}</${tag}></div>${notes ? `<aside class="notes">${notes}</aside>` : ""}</div>`;
  }).join("");
  const n = notesOf(a);
  const body = `
<div class="a-progress"><span style="width:${a.progress || 0}%"></span></div>
<article class="essay">
  <header class="essay-head">
    <p class="kicker"><a href="/articles">Статті</a>${a.topics?.length ? ` · ${a.topics.map(esc).join(", ")}` : ""}</p>
    <h1>${esc(a.title)}</h1>
    ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
    <p class="by-line"><b>${esc(a.author)}</b> · ${esc(a.source)} · ${esc(a.date)} · ${minutes(a)} читання</p>
    <div class="a-acts">
      <button class="btn small${a.later ? " on" : ""}">${a.later ? "✓ У черзі" : "+ Прочитати пізніше"}</button>
      <a class="btn small ghost" href="${attr(a.url)}" rel="nofollow noopener" target="_blank">Оригінал ↗</a>
      ${n ? `<span class="a-count">${count(n, "пояснення", "пояснення", "пояснень")} від читачів</span>` : ""}
    </div>
  </header>
  <div class="a-hint-m">${hint}</div>
  <div class="essay-body">${blocks}</div>
  <footer class="essay-foot">
    <p class="src">Текст: ${esc(a.author)}, <a href="${attr(a.url)}" rel="nofollow noopener" target="_blank">${esc(a.source)}</a>. Додав <a href="/@${attr(a.by.username)}">${esc(a.by.name)}</a></p>
  </footer>
</article>
${next.length ? `<section class="a-next"><div class="label"><h2>Читати далі</h2></div><div class="arows">${next.map(row).join("")}</div></section>` : ""}
<div class="sel-bubble" hidden>${user ? `<button>Пояснити</button><button>Запитати</button><button>Зберегти</button>` : `<span>Пояснити</span><a href="/login">Увійти</a>`}</div>
<script>
(function(){
  var b=document.querySelector('.sel-bubble'), body=document.querySelector('.essay-body');
  document.addEventListener('mouseup',function(){ setTimeout(function(){
    var s=getSelection(); if(!s.rangeCount||s.isCollapsed||!body.contains(s.anchorNode)){b.hidden=true;return;}
    var r=s.getRangeAt(0).getBoundingClientRect(); b.hidden=false;
    b.style.top=(r.top+scrollY-b.offsetHeight-10)+'px'; b.style.left=(r.left+scrollX+r.width/2-b.offsetWidth/2)+'px';
  },0)});
  // Margin notes never stretch the text: each column sits at its paragraph, pushed down only past the one above.
  function lay(){ var bottom=0; document.querySelectorAll('.arow-b > .notes').forEach(function(n){ n.style.transform=''; if(getComputedStyle(n).height==='auto'||innerWidth<=820) return; var r=n.getBoundingClientRect(), top=r.top+scrollY, h=n.scrollHeight; var shift=Math.max(0,bottom+16-top); n.style.transform=shift?'translateY('+shift+'px)':''; bottom=top+shift+h; }); }
  lay(); addEventListener('resize',lay); document.fonts&&document.fonts.ready.then(lay);
  body.addEventListener('click',function(e){ var m=e.target.closest('mark.ex'); if(!m) return; m.closest('.arow-b').classList.toggle('open'); });
})();
</script>`;
  return pages.layout({ title: a.title, body, user, path: "/articles", canonical: `/articles/${a.slug}`, description: a.dek || "", noindex: true, type: "article" });
}

module.exports = { Articles, indexPage, articlePage, TOPICS };
