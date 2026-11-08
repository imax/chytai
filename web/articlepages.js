// The pages of «Статті» (articles.js): the list at /articles and an article at /articles/<slug>.
// Design from the mockup Max liked on 2026-11-08 («вогонь», «виглядає класно»): the text in a column, readers'
// explanations in the margin (under the paragraph on a phone), a read-later queue, «Читати далі» by topic.
const pages = require("./pages");
const { esc, mdHtml } = pages;
const attr = esc;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const dateOf = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const pct = (a) => (a.read && a.read.blocks ? Math.min(100, Math.round(((a.read.block + 1) / a.read.blocks) * 100)) : 0);

const laterBtn = (a, user, cls = "later") =>
  user
    ? `<button type="button" class="${cls}${a.later ? " on" : ""}" data-later="${attr(a.slug)}">${a.later ? "✓ У черзі" : cls === "later" ? "+ Пізніше" : "+ Прочитати пізніше"}</button>`
    : `<a class="${cls}" rel="nofollow" href="/login?next=${encodeURIComponent(a.href)}">${cls === "later" ? "+ Пізніше" : "+ Прочитати пізніше"}</a>`;

function row(a, user) {
  const p = pct(a);
  const meta = [a.author ? esc(a.author) : "", esc(a.source), `${a.minutes} хв`, a.notes ? count(a.notes, "пояснення", "пояснення", "пояснень") : "", p >= 95 ? "прочитано" : p > 3 ? `прочитано ${p}%` : ""].filter(Boolean).join(" · ");
  return `<div class="arow" data-topics="${attr(a.topics.join("|"))}">
  <a class="t" href="${attr(a.href)}"><b>${esc(a.title)}</b>${a.hidden ? ` <span class="tag spoil-tag">сховано</span>` : ""}</a>
  ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
  <p class="m">${a.topics.length ? `<span class="topic">${a.topics.map(esc).join(", ")}</span> · ` : ""}${meta}</p>
  ${laterBtn(a, user)}
</div>`;
}

function indexPage({ user, list, later = [], owner = false, blocked = [], error = "", url = "" }) {
  const add = user
    ? `<form class="a-add" method="post" action="/api/articles" data-add><input type="url" name="url" required value="${attr(url)}" placeholder="Посилання на статтю" aria-label="Посилання на статтю"><button class="btn primary">Додати</button></form>`
    : `<a class="btn primary" rel="nofollow" href="/login?next=/articles">Додати статтю</a>`;
  const topics = [...new Set(list.flatMap((a) => a.topics))];
  const body = `
<section class="page-head a-head">
  <div>
    <h1>Статті</h1>
    <p class="lead">Есе й довгі тексти.</p>
  </div>
  <div class="head-act">${add}${error ? `<p class="error a-err">${esc(error)}</p>` : ""}<p class="a-wait small muted" hidden>Беру текст зі сторінки…</p></div>
</section>
<div class="a-index">
${user && later.length ? `<div class="label"><h2>Прочитати пізніше</h2></div><div class="arows">${later.map((a) => row(a, user)).join("")}</div>` : ""}
<div class="label"><h2>Усі статті</h2><div class="aside">${list.length}</div></div>
${topics.length > 1 ? `<div class="a-topics" data-topic-chips><button type="button" class="chip on" data-topic="">Усі</button>${topics.map((t) => `<button type="button" class="chip" data-topic="${attr(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
${list.length ? `<div class="arows" data-all>${list.map((a) => row(a, user)).join("")}</div>` : `<p class="muted">Статей ще немає. Додайте першу!</p>`}
${owner ? `<div class="a-owner"><div class="label"><h2>Заблоковані сайти</h2></div>
  <p class="small muted">${blocked.length ? blocked.map((d) => `${esc(d)} <form method="post" action="/api/articles/block" class="inline"><input type="hidden" name="domain" value="${attr(d)}"><input type="hidden" name="off" value="1"><button class="text-link small">розблокувати</button></form>`).join(" · ") : "Немає."}</p>
  <form method="post" action="/api/articles/block" class="a-add"><input name="domain" placeholder="example.com" aria-label="Сайт"><button class="btn small">Заблокувати</button></form></div>` : ""}
</div>
<script>${INDEX_JS}</script>`;
  return pages.layout({ title: "Статті", body, user, path: "/articles", canonical: "/articles", description: "Есе й довгі статті, які читачі принесли в Chytai." });
}

// The explained words in a paragraph get a dotted line; quotes across tags just stay unmarked.
function markBlock(html, notes = []) {
  notes.forEach((n) => {
    const q = esc(n.quote);
    const at = html.indexOf(q);
    if (at >= 0 && !/<[^>]*$/.test(html.slice(0, at))) html = `${html.slice(0, at)}<mark class="ex" data-note="${attr(n.id)}">${q}</mark>${html.slice(at + q.length)}`;
  });
  return html;
}
function noteHtml(n, owner = false) {
  const asked = Number(n.asked) || 1;
  return `<div class="anote" id="n-${attr(n.id)}" data-note="${attr(n.id)}">
  <p class="nq">${esc(n.quote.length > 120 ? n.quote.slice(0, 117) + "…" : n.quote)}</p>
  <div class="nt">${mdHtml(n.text)}</div>
  <p class="nm">${asked > 1 ? `питали ${count(asked, "читач", "читачі", "читачів")}` : "питав 1 читач"}${owner ? ` · <form method="post" action="/api/articles/notes/${attr(n.id)}/delete" class="inline"><button class="text-link small">прибрати</button></form>` : ""}</p>
</div>`;
}
function blockHtml(a, i, { owner = false, hint = "" } = {}) {
  const b = a.blocks[i];
  const notes = a.notesBy[i] || [];
  const aside = (i === 0 ? hint : "") + notes.map((n) => noteHtml(n, owner)).join("");
  const inner = b.t === "pre" ? b.h : markBlock(b.h, notes);
  return `<div class="arow-b" id="p${i + 1}" data-block="${i}"><div class="txt"><a class="pl" href="#p${i + 1}" title="Посилання на абзац">¶</a><${b.t}>${inner}</${b.t}></div>${aside ? `<aside class="notes">${aside}</aside>` : `<aside class="notes"></aside>`}</div>`;
}

function articlePage({ user, a, next = [], owner = false, by = null, banned = false }) {
  const hint = user
    ? `<p class="a-hint">Виділіть слово чи речення, щоб Claude пояснив.</p>`
    : `<p class="a-hint">Пояснення, які попросили інші читачі. <a rel="nofollow" href="/login?next=${encodeURIComponent(a.href)}">Увійдіть</a>, щоб спитати своє.</p>`;
  const n = Object.values(a.notesBy).reduce((s, l) => s + l.length, 0);
  const date = dateOf(a.published);
  const resume = a.read && a.read.block > 2 && pct(a) < 95 ? `<a class="btn small ghost" href="#p${a.read.block + 1}">↓ Продовжити</a>` : "";
  const host = (() => {
    try {
      return new URL(a.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const tools = owner
    ? `<div class="a-tools small"><span class="muted">Власнику:</span>
  <form method="post" action="/api/articles/${attr(a.id)}/hide" class="inline"><input type="hidden" name="hidden" value="${a.hidden ? "" : "1"}"><button class="text-link small">${a.hidden ? "Показати всім" : "Сховати"}</button></form>
  <form method="post" action="/api/articles/${attr(a.id)}/delete" class="inline" onsubmit="return confirm('Видалити статтю разом з поясненнями?')"><button class="text-link small danger">Видалити</button></form>
  ${by && !by.owner ? `<form method="post" action="/api/articles/ban" class="inline"><input type="hidden" name="reader" value="${attr(a.reader)}"><input type="hidden" name="back" value="${attr(a.href)}">${banned ? `<input type="hidden" name="off" value="1"><button class="text-link small">Дозволити @${esc(by.username)} додавати</button>` : `<button class="text-link small">Заборонити @${esc(by.username)} додавати</button>`}</form>` : ""}
  ${host ? `<form method="post" action="/api/articles/block" class="inline"><input type="hidden" name="domain" value="${attr(host)}"><input type="hidden" name="back" value="${attr(a.href)}"><button class="text-link small">Заблокувати ${esc(host)}</button></form>` : ""}
</div>`
    : "";
  const body = `
<div class="a-progress"><span></span></div>
<article class="essay" data-slug="${attr(a.slug)}" data-blocks="${a.blocks.length}" data-signed="${user ? 1 : 0}">
  <header class="essay-head">
    <p class="kicker"><a href="/articles">Статті</a>${a.topics.length ? ` · ${a.topics.map(esc).join(", ")}` : ""}${a.hidden ? ` · <span class="danger">сховано</span>` : ""}</p>
    <h1>${esc(a.title)}</h1>
    ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
    <p class="by-line">${[a.author ? `<b>${esc(a.author)}</b>` : "", esc(a.source), date, `${a.minutes} хв читання`].filter(Boolean).join(" · ")}</p>
    <div class="a-acts">
      ${laterBtn(a, user, "btn small")}
      <a class="btn small ghost" href="${attr(a.url)}" rel="nofollow noopener" target="_blank">Оригінал ↗</a>
      ${resume}
      ${n ? `<span class="a-count">${count(n, "пояснення", "пояснення", "пояснень")} від читачів</span>` : ""}
    </div>
    ${tools}
  </header>
  <div class="a-hint-m">${hint}</div>
  <div class="essay-body">${a.blocks.map((_, i) => blockHtml(a, i, { owner, hint })).join("")}</div>
  <footer class="essay-foot">
    <p class="src">Текст: ${a.author ? `${esc(a.author)}, ` : ""}<a href="${attr(a.url)}" rel="nofollow noopener" target="_blank">${esc(a.source || host)}</a>.${by ? ` Додав <a href="/@${attr(by.username)}">${esc(by.name)}</a>.` : ""}</p>
  </footer>
</article>
${next.length ? `<section class="a-next"><div class="label"><h2>Читати далі</h2></div><div class="arows">${next.map((x) => row(x, user)).join("")}</div></section>` : ""}
<div class="sel-bubble" hidden>${user ? `<button type="button" data-explain>Пояснити</button>` : `<span>Пояснити</span><a rel="nofollow" href="/login?next=${encodeURIComponent(a.href)}">Увійти</a>`}</div>
<script>${ARTICLE_JS}</script>`;
  return pages.layout({ title: a.title, body, user, path: "/articles", description: a.dek || "", noindex: true, type: "article" });
}

// «+ Пізніше» anywhere, the topic chips, the add form's wait line.
const LATER_JS = `
document.addEventListener('click',function(e){var b=e.target.closest('button[data-later]');if(!b)return;b.disabled=true;
fetch('/api/articles/'+encodeURIComponent(b.dataset.later)+'/later',{method:'POST',headers:{'Accept':'application/json'}}).then(function(r){return r.json()}).then(function(d){
document.querySelectorAll('button[data-later="'+b.dataset.later+'"]').forEach(function(x){x.classList.toggle('on',d.later);x.textContent=d.later?'✓ У черзі':(x.classList.contains('later')?'+ Пізніше':'+ Прочитати пізніше')})}).finally(function(){b.disabled=false})});`;
const INDEX_JS = `(function(){${LATER_JS}
var chips=document.querySelector('[data-topic-chips]');if(chips)chips.addEventListener('click',function(e){var c=e.target.closest('[data-topic]');if(!c)return;chips.querySelectorAll('.chip').forEach(function(x){x.classList.toggle('on',x===c)});
document.querySelectorAll('[data-all] .arow').forEach(function(r){r.hidden=!!c.dataset.topic&&r.dataset.topics.split('|').indexOf(c.dataset.topic)<0})});
var f=document.querySelector('form[data-add]');if(f)f.addEventListener('submit',function(){f.querySelector('button').disabled=true;document.querySelector('.a-wait').hidden=false;var e=document.querySelector('.a-err');if(e)e.hidden=true});
})();`;
// The reading page: the progress bar and where the reader stopped, the selection bubble and «Пояснити», margin
// notes laid out so they never stretch the text, tap on underlined words on a phone.
const ARTICLE_JS = `(function(){${LATER_JS}
var art=document.querySelector('.essay'),body=document.querySelector('.essay-body'),bubble=document.querySelector('.sel-bubble'),bar=document.querySelector('.a-progress span');
var slug=art.dataset.slug,total=+art.dataset.blocks,signed=art.dataset.signed==='1',phone=function(){return innerWidth<=820};
function lay(){var bottom=0;document.querySelectorAll('.arow-b > .notes').forEach(function(n){n.style.transform='';if(phone()||!n.children.length)return;var top=n.getBoundingClientRect().top+scrollY;var shift=Math.max(0,bottom+16-top);if(shift)n.style.transform='translateY('+shift+'px)';bottom=top+shift+n.scrollHeight})}
lay();addEventListener('resize',lay);if(document.fonts)document.fonts.ready.then(lay);addEventListener('load',lay);
var furthest=-1,sent=-1,timer=0;
function onScroll(){var h=body.getBoundingClientRect();var p=Math.min(1,Math.max(0,(innerHeight*0.6-h.top)/h.height));bar.style.width=(p*100)+'%';
if(!signed)return;var rows=body.children,i=0;for(;i<rows.length;i++){if(rows[i].getBoundingClientRect().top>innerHeight*0.6)break}furthest=Math.max(0,i-1);
if(!timer)timer=setTimeout(function(){timer=0;if(furthest===sent)return;sent=furthest;fetch('/api/articles/'+encodeURIComponent(slug)+'/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({block:furthest,blocks:total}),keepalive:true})},4000)}
addEventListener('scroll',onScroll,{passive:true});onScroll();
var sel=null;
function blockOf(n){n=n&&(n.nodeType===1?n:n.parentNode);var r=n&&n.closest('.arow-b');return r&&body.contains(r)?r:null}
function place(){var s=getSelection();var r0=s.rangeCount?s.getRangeAt(0):null;var row=r0&&!s.isCollapsed?blockOf(s.anchorNode):null;
if(!row){bubble.hidden=true;sel=null;return}var txt=row.querySelector('.txt');var r=r0.cloneRange();if(!txt.contains(r.startContainer))r.setStart(txt,0);if(!txt.contains(r.endContainer))r.setEnd(txt,txt.childNodes.length);
var q=r.toString().replace(/\\s+/g,' ').trim();if(q.length<2){bubble.hidden=true;return}sel={row:row,quote:q.slice(0,600)};var b=r.getBoundingClientRect();bubble.hidden=false;
bubble.style.top=Math.max(scrollY+4,b.top+scrollY-bubble.offsetHeight-10)+'px';bubble.style.left=Math.max(8,Math.min(innerWidth-bubble.offsetWidth-8,b.left+scrollX+b.width/2-bubble.offsetWidth/2))+'px'}
document.addEventListener('mouseup',function(){setTimeout(place,0)});document.addEventListener('touchend',function(){setTimeout(place,250)});
document.addEventListener('selectionchange',function(){if(getSelection().isCollapsed)setTimeout(function(){if(getSelection().isCollapsed)bubble.hidden=true},200)});
bubble.addEventListener('mousedown',function(e){e.preventDefault()});
bubble.addEventListener('click',function(e){var b=e.target.closest('[data-explain]');if(!b||!sel)return;var s=sel,aside=s.row.querySelector('.notes');
var wait=document.createElement('div');wait.className='anote wait';wait.innerHTML='<p class="nq"></p><p class="nt">Claude пояснює…</p>';wait.querySelector('.nq').textContent=s.quote.length>120?s.quote.slice(0,117)+'…':s.quote;aside.appendChild(wait);s.row.classList.add('open');lay();
bubble.hidden=true;getSelection().removeAllRanges();
fetch('/api/articles/'+encodeURIComponent(slug)+'/explain',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({block:+s.row.dataset.block,quote:s.quote})}).then(function(r){return r.json()}).then(function(d){
if(d.error){wait.classList.add('err');wait.querySelector('.nt').textContent=d.error;return}var t=document.createElement('div');t.innerHTML=d.html;var fresh=t.firstElementChild;fresh.classList.add('open');s.row.replaceWith(fresh);lay();
var n=fresh.querySelector('.anote[data-note="'+d.note+'"]');if(n){n.classList.add('flash');setTimeout(function(){n.classList.remove('flash')},1600)}}).catch(function(){wait.classList.add('err');wait.querySelector('.nt').textContent='Не вийшло. Спробуйте ще раз.'})});
body.addEventListener('click',function(e){var m=e.target.closest('mark.ex');if(m){var row=m.closest('.arow-b');if(phone())row.classList.toggle('open');var n=row.querySelector('.anote[data-note="'+m.dataset.note+'"]');if(n){n.classList.add('flash','full');setTimeout(function(){n.classList.remove('flash')},1600)}return}
var nt=e.target.closest('.anote .nt');if(nt&&!e.target.closest('a')){nt.parentNode.classList.toggle('full');lay()}});
})();`;

module.exports = { indexPage, articlePage, blockHtml, noteHtml };
