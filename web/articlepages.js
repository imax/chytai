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

function indexPage({ user, list, later = [], owner = false, blocked = [], error = "", url = "", hlCount = 0 }) {
  const add = user
    ? `<form class="a-add" method="post" action="/api/articles" data-add><input type="url" name="url" required value="${attr(url)}" placeholder="Посилання на статтю" aria-label="Посилання на статтю"><button class="btn primary">Додати</button></form>`
    : `<a class="btn primary" rel="nofollow" href="/login?next=/articles">Додати статтю</a>`;
  const topics = [...new Set(list.flatMap((a) => a.topics))];
  const body = `
<section class="page-head a-head">
  <div>
    <h1>Статті</h1>
    <p class="lead">Есе й довгі тексти.</p>
    ${hlCount ? `<p class="a-mine"><a href="/articles/highlights">Мої виділення · ${hlCount}</a></p>` : ""}
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
// A reader's public note (Max, 2026-11-08: «нотатка публічна теж»): plain text, their name, «прибрати» for the owner.
function readerNoteHtml(n, owner = false) {
  return `<div class="anote reader" data-note="r-${attr(n.id)}">
  <p class="nq">${esc(n.quote.length > 120 ? n.quote.slice(0, 117) + "…" : n.quote)}</p>
  <p class="nt">${esc(n.note)}</p>
  <p class="nm"><a href="/@${attr(n.by.username)}">${esc(n.by.name)}</a>${owner ? ` · <form method="post" action="/api/articles/highlights/${attr(n.id)}/clear" class="inline"><button class="text-link small">прибрати</button></form>` : ""}</p>
</div>`;
}
function blockHtml(a, i, { owner = false, hint = "" } = {}) {
  const b = a.blocks[i];
  const notes = a.notesBy[i] || [];
  const theirs = (a.readerNotes || {})[i] || [];
  const aside = (i === 0 ? hint : "") + notes.map((n) => noteHtml(n, owner)).join("") + theirs.map((n) => readerNoteHtml(n, owner)).join("");
  const inner = b.t === "pre" ? b.h : markBlock(b.h, [...notes, ...theirs.map((n) => ({ id: `r-${n.id}`, quote: n.quote }))]);
  return `<div class="arow-b" id="p${i + 1}" data-block="${i}"><div class="txt"><a class="pl" href="#p${i + 1}" title="Посилання на абзац">¶</a><${b.t}>${inner}</${b.t}></div>${aside ? `<aside class="notes">${aside}</aside>` : `<aside class="notes"></aside>`}</div>`;
}

const KIND = { essay: "есе", article: "стаття", book: "книжка", paper: "дослідження", speech: "промова" };
// «Ще почитати»: what the text names, then what Claude suggests. Ours open here; the rest open the original.
function moreHtml(a, user, owner) {
  if (!a.more || !a.more.length) return owner && a.more ? `<section class="a-more"><form method="post" action="/api/articles/${attr(a.id)}/more" class="inline small"><button class="text-link small">Зібрати «Ще почитати» ще раз</button></form></section>` : "";
  const item = (it) => {
    const search = `https://www.google.com/search?q=${encodeURIComponent(`"${it.title}" ${it.author || ""}`.trim())}`;
    const href = it.href || it.book || it.url || search;
    const out = !it.href && !it.book;
    const meta = [it.author ? esc(it.author) : "", KIND[it.kind] || "", it.book ? "є в каталозі" : it.href ? "є в Статтях" : "", it.from === "text" ? "згадано в тексті" : "радить ШІ"].filter(Boolean).join(" · ");
    const add = user && it.url && !it.href && it.kind !== "book" ? `<form method="post" action="/api/articles" class="inline"><input type="hidden" name="url" value="${attr(it.url)}"><button class="m-add" title="Додати в Статті й читати тут">+ Додати</button></form>` : "";
    return `<li><a class="t" href="${attr(href)}"${out ? ` rel="nofollow noopener" target="_blank"` : ""}>${esc(it.title)}${out ? ` <span class="out">${it.url ? "↗" : "пошук ↗"}</span>` : ""}</a>${add}
  <p class="m">${meta}</p>${it.why ? `<p class="why">${esc(it.why)}</p>` : ""}</li>`;
  };
  return `<section class="a-more"><div class="label"><h2>Ще почитати</h2></div><ul class="more">${a.more.map(item).join("")}</ul>${owner ? `<form method="post" action="/api/articles/${attr(a.id)}/more" class="inline small"><button class="text-link small">Зібрати ще раз</button></form>` : ""}</section>`;
}

function articlePage({ user, a, next = [], owner = false, by = null, banned = false }) {
  const hint = user
    ? `<p class="a-hint">Виділіть текст, щоб Claude пояснив або щоб зберегти думку.</p>`
    : `<p class="a-hint">Пояснення, які попросили інші читачі. <a rel="nofollow" href="/login?next=${encodeURIComponent(a.href)}">Увійдіть</a>, щоб спитати своє чи зберегти думку.</p>`;
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
      ${user ? `<a class="a-count a-hl-count" href="#mine"${a.highlights.length ? "" : " hidden"}>${a.highlights.length ? count(a.highlights.length, "виділення", "виділення", "виділень") : ""}</a>` : ""}
    </div>
    ${tools}
  </header>
  <div class="a-hint-m">${hint}</div>
  <div class="essay-body">${a.blocks.map((_, i) => blockHtml(a, i, { owner, hint })).join("")}</div>
  <footer class="essay-foot">
    <p class="src">Текст: ${a.author ? `${esc(a.author)}, ` : ""}<a href="${attr(a.url)}" rel="nofollow noopener" target="_blank">${esc(a.source || host)}</a>.${by ? ` Додав <a href="/@${attr(by.username)}">${esc(by.name)}</a>.` : ""}</p>
  </footer>
</article>
${user ? `<section class="a-hls" id="mine"${a.highlights.length ? "" : " hidden"}><div class="label"><h2>Мої виділення</h2><div class="aside"><button type="button" class="text-link small" data-copy>Копіювати</button> · <a class="small" href="/articles/highlights">Усі</a></div></div><ul class="hls"></ul></section>` : ""}
${moreHtml(a, user, owner)}
${next.length ? `<section class="a-next"><div class="label"><h2>Читати далі</h2></div><div class="arows">${next.map((x) => row(x, user)).join("")}</div></section>` : ""}
<div class="sel-bubble" hidden>${user ? `<button type="button" data-explain>Пояснити</button><button type="button" data-save>Зберегти</button><button type="button" data-note>Нотатка</button><button type="button" data-hl-edit hidden>Нотатка</button><button type="button" data-unsave hidden>Прибрати</button>` : `<span>Пояснити чи зберегти</span><a rel="nofollow" href="/login?next=${encodeURIComponent(a.href)}">Увійти</a>`}</div>
<script type="application/json" id="hl-data">${JSON.stringify({ hl: a.highlights, title: a.title, author: a.author, url: a.url, href: a.href }).replace(/</g, "\\u003c")}</script>
<script>${ARTICLE_JS}</script>`;
  return pages.layout({ title: a.title, body, user, path: "/articles", description: a.dek || "", noindex: true, type: "article" });
}

// Every highlight of the reader, article by article, the last marked first; each quote leads to its paragraph.
function highlightsPage({ user, list }) {
  const md = (a) => `**${a.title}**${a.author ? `, ${a.author}` : ""}\n${SITE_HINT}${a.href}\n\n${a.highlights.map((h) => `> ${h.quote}${h.note ? `\n\n${h.note}` : ""}`).join("\n\n")}\n`;
  const body = `
<section class="page-head a-head"><div><p class="kicker"><a href="/articles">Статті</a></p><h1>Мої виділення</h1><p class="lead">Думки, які ви зберегли. Виділення бачите лише ви, нотатки бачать усі.</p></div></section>
<div class="a-index">
${list.length ? list.map((a) => `<section class="a-hl-art">
  <div class="label"><h2><a href="${attr(a.href)}">${esc(a.title)}</a></h2><div class="aside"><button type="button" class="text-link small" data-md="${attr(md(a))}">Копіювати</button></div></div>
  <p class="m small muted">${[a.author ? esc(a.author) : "", esc(a.source), count(a.highlights.length, "виділення", "виділення", "виділень")].filter(Boolean).join(" · ")}</p>
  <ul class="hls">${a.highlights.map((h) => `<li><a href="${attr(a.href)}#p${h.block + 1}">${esc(h.quote)}</a>${h.note ? `<p class="hn">${esc(h.note)}</p>` : ""}</li>`).join("")}</ul>
</section>`).join("") : `<p class="muted">Поки нічого. Виділіть текст у статті й натисніть «Зберегти».</p>`}
</div>
<script>document.addEventListener('click',function(e){var b=e.target.closest('[data-md]');if(!b)return;navigator.clipboard.writeText(b.dataset.md.split('${SITE_HINT}').join(location.origin)).then(function(){b.textContent='Скопійовано';setTimeout(function(){b.textContent='Копіювати'},1600)})});</script>`;
  return pages.layout({ title: "Мої виділення", body, user, path: "/articles", noindex: true });
}
const SITE_HINT = "@@site@@";

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
// The reader's own highlights: marked over the text by its words (they may cross <em> or a link), listed under
// the text with links to their paragraphs, «Копіювати» as Markdown quotes for notes elsewhere.
const HL_JS = `var D=JSON.parse(document.getElementById('hl-data').textContent),HL=D.hl,unsel=null;
function nodesOf(el){var out=[],w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),n;while((n=w.nextNode()))if(!n.parentNode.closest('.pl'))out.push(n);return out}
function markHl(row,h){var s='',map=[];nodesOf(row.querySelector('.txt')).forEach(function(n){for(var i=0;i<n.data.length;i++){var c=n.data[i];if(/\\s/.test(c)){if(!s.length||s[s.length-1]===' ')continue;c=' '}s+=c;map.push([n,i])}});
var q=h.quote.replace(/\\s+/g,' ').trim(),at=s.indexOf(q);if(at<0||!q)return;var segs=[];for(var k=at;k<at+q.length;k++){var m=map[k],l=segs[segs.length-1];if(l&&l.n===m[0])l.e=m[1]+1;else segs.push({n:m[0],s:m[1],e:m[1]+1})}
segs.reverse().forEach(function(g){var n=g.n;if(g.e<n.data.length)n.splitText(g.e);var mid=g.s>0?n.splitText(g.s):n;var mk=document.createElement('mark');mk.className='hl';mk.dataset.hl=h.id;mid.parentNode.insertBefore(mk,mid);mk.appendChild(mid)})}
function short(q){return q.length>120?q.slice(0,117)+'…':q}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function mine(row){var aside=row.querySelector('.notes');aside.querySelectorAll('.anote.mine:not(.edit)').forEach(function(x){x.remove()});var any=false;
HL.forEach(function(h){if(h.block!==+row.dataset.block||!h.note)return;any=true;var d=el('div','anote mine');d.dataset.hl=h.id;d.appendChild(el('p','nq',short(h.quote)));d.appendChild(el('p','nt',h.note));d.appendChild(el('p','nm','ваша нотатка · бачать усі'));aside.appendChild(d)});
if(any&&phone())row.classList.add('open')}
function markRow(row){HL.forEach(function(h){if(h.block===+row.dataset.block)markHl(row,h)});mine(row)}
function find(id){for(var i=0;i<HL.length;i++)if(HL[i].id===id)return HL[i];return null}
function list(){var sec=document.querySelector('.a-hls'),cnt=document.querySelector('.a-hl-count');if(!sec)return;HL.sort(function(a,b){return a.block-b.block});var ul=sec.querySelector('.hls');ul.innerHTML='';
HL.forEach(function(h){var li=el('li'),a=el('a',null,h.quote);a.href='#p'+(h.block+1);li.appendChild(a);if(h.note)li.appendChild(el('p','hn',h.note));ul.appendChild(li)});sec.hidden=!HL.length;
var n=HL.length,w=n%10===1&&n%100!==11?'виділення':'виділень';if(n%10>=2&&n%10<=4&&(n%100<10||n%100>=20))w='виділення';cnt.hidden=!n;cnt.textContent=n+' '+w}
document.querySelectorAll('.arow-b').forEach(markRow);list();lay();
function post(url,data){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(data||{})}).then(function(r){return r.json()})}
function keep(row,d){var h=find(d.id);if(h){h.note=d.note}else{HL.push(d);markHl(row,d)}mine(row);list();lay()}
function saveHl(row,quote,note){var data={block:+row.dataset.block,quote:quote};if(note!=null)data.note=note;
return post('/api/articles/'+encodeURIComponent(slug)+'/highlight',data).then(function(d){if(d.error)return alertLine(row,d.error);keep(row,d)})}
// The note editor sits where the notes are: in the margin, or under the paragraph on a phone.
function editor(row,quote,h){var aside=row.querySelector('.notes');aside.querySelectorAll('.anote.edit').forEach(function(x){x.remove()});
var d=el('div','anote mine edit');d.appendChild(el('p','nq',short(quote)));var t=el('textarea');t.rows=3;t.maxLength=2000;t.placeholder='Ваша думка. Її побачать усі читачі.';t.value=h&&h.note||'';d.appendChild(t);
var b=el('p','nb'),ok=el('button','btn small primary','Зберегти'),no=el('button','text-link small','Скасувати');ok.type=no.type='button';b.appendChild(ok);b.appendChild(no);d.appendChild(b);
var old=h&&aside.querySelector('.anote.mine[data-hl="'+h.id+'"]');if(old)old.hidden=true;aside.appendChild(d);row.classList.add('open');lay();t.focus();
no.onclick=function(){d.remove();if(old)old.hidden=false;lay()};
ok.onclick=function(){ok.disabled=true;var v=t.value.trim();(h?post('/api/articles/highlights/'+encodeURIComponent(h.id)+'/note',{note:v}).then(function(r){if(r.error)return alertLine(row,r.error);keep(row,r)}):saveHl(row,quote,v)).then(function(){d.remove();lay()})}}
var save=bubble.querySelector('[data-save]');if(save)save.addEventListener('click',function(){if(!sel)return;var s=sel;bubble.hidden=true;getSelection().removeAllRanges();saveHl(s.row,s.quote)});
var nb=bubble.querySelector('[data-note]');if(nb)nb.addEventListener('click',function(){if(!sel)return;var s=sel;bubble.hidden=true;getSelection().removeAllRanges();editor(s.row,s.quote,null)});
var ed=bubble.querySelector('[data-hl-edit]');if(ed)ed.addEventListener('click',function(){var h=find(unsel);unsel=null;bubble.hidden=true;if(!h)return;var row=document.querySelector('.arow-b[data-block="'+h.block+'"]');editor(row,h.quote,h)});
body.addEventListener('click',function(e){var m=e.target.closest('.anote.mine:not(.edit)');if(!m||e.target.closest('a'))return;var h=find(m.dataset.hl);if(h)editor(m.closest('.arow-b'),h.quote,h)});
var un=bubble.querySelector('[data-unsave]');if(un)un.addEventListener('click',function(){var id=unsel;unsel=null;bubble.hidden=true;if(!id)return;post('/api/articles/highlights/'+encodeURIComponent(id)+'/delete').then(function(){var h=find(id);HL=HL.filter(function(x){return x.id!==id});
document.querySelectorAll('mark.hl[data-hl="'+id+'"]').forEach(function(m){var p=m.parentNode;while(m.firstChild)p.insertBefore(m.firstChild,m);p.removeChild(m);p.normalize()});if(h)mine(document.querySelector('.arow-b[data-block="'+h.block+'"]'));list();lay()})});
function alertLine(row,t){var p=el('p','a-hl-err',t);row.querySelector('.txt').appendChild(p);setTimeout(function(){p.remove()},4000)}
var copy=document.querySelector('[data-copy]');if(copy)copy.addEventListener('click',function(){var md='**'+D.title+'**'+(D.author?', '+D.author:'')+'\\n'+location.origin+D.href+'\\n\\n'+HL.map(function(h){return '> '+h.quote+(h.note?'\\n\\n'+h.note:'')}).join('\\n\\n')+'\\n';
navigator.clipboard.writeText(md).then(function(){copy.textContent='Скопійовано';setTimeout(function(){copy.textContent='Копіювати'},1600)})});`;

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
function place(){var s=getSelection();var r0=s.rangeCount?s.getRangeAt(0):null;var row=r0&&!s.isCollapsed?blockOf(s.anchorNode):null;if(row&&!row.querySelector('.txt').contains(s.anchorNode))row=null;
if(!row){if(!unsel)bubble.hidden=true;sel=null;return}unsel=null;var txt=row.querySelector('.txt');var r=r0.cloneRange();if(!txt.contains(r.startContainer))r.setStart(txt,0);if(!txt.contains(r.endContainer))r.setEnd(txt,txt.childNodes.length);snap(r);
var q=r.toString().replace(/\\s+/g,' ').replace(/^¶\\s*/,'').trim();if(q.length<2){bubble.hidden=true;return}sel={row:row,quote:q};mode(false);var b=r.getBoundingClientRect();show(b)}
var W=/[\\p{L}\\p{N}'’-]/u;function snap(r){var s=r.startContainer,e=r.endContainer,o;if(s.nodeType===3){o=r.startOffset;while(o>0&&W.test(s.data[o-1]))o--;r.setStart(s,o)}if(e.nodeType===3){o=r.endOffset;while(o<e.data.length&&W.test(e.data[o]))o++;r.setEnd(e,o)}}
function mode(un){bubble.querySelectorAll('[data-explain],[data-save],[data-note]').forEach(function(x){x.hidden=un});bubble.querySelectorAll('[data-hl-edit],[data-unsave]').forEach(function(x){x.hidden=!un});
var e=bubble.querySelector('[data-hl-edit]'),h=un&&typeof find==='function'?find(unsel):null;if(e)e.textContent=h&&h.note?'Змінити нотатку':'Нотатка'}
function show(b){bubble.hidden=false;
bubble.style.top=Math.max(scrollY+4,b.top+scrollY-bubble.offsetHeight-10)+'px';bubble.style.left=Math.max(8,Math.min(innerWidth-bubble.offsetWidth-8,b.left+scrollX+b.width/2-bubble.offsetWidth/2))+'px'}
document.addEventListener('mouseup',function(){setTimeout(place,0)});document.addEventListener('touchend',function(){setTimeout(place,250)});
document.addEventListener('selectionchange',function(){if(getSelection().isCollapsed)setTimeout(function(){if(getSelection().isCollapsed&&!unsel)bubble.hidden=true},200)});
document.addEventListener('click',function(e){if(unsel&&!e.target.closest('mark.hl')&&!e.target.closest('.sel-bubble')){unsel=null;bubble.hidden=true}});
bubble.addEventListener('mousedown',function(e){e.preventDefault()});
bubble.addEventListener('click',function(e){var b=e.target.closest('[data-explain]');if(!b||!sel)return;var s={row:sel.row,quote:sel.quote.slice(0,600)},aside=s.row.querySelector('.notes');
var wait=document.createElement('div');wait.className='anote wait';wait.innerHTML='<p class="nq"></p><p class="nt">Claude пояснює…</p>';wait.querySelector('.nq').textContent=s.quote.length>120?s.quote.slice(0,117)+'…':s.quote;aside.appendChild(wait);s.row.classList.add('open');lay();
bubble.hidden=true;getSelection().removeAllRanges();
fetch('/api/articles/'+encodeURIComponent(slug)+'/explain',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({block:+s.row.dataset.block,quote:s.quote})}).then(function(r){return r.json()}).then(function(d){
if(d.error){wait.classList.add('err');wait.querySelector('.nt').textContent=d.error;return}var t=document.createElement('div');t.innerHTML=d.html;var fresh=t.firstElementChild;fresh.classList.add('open');s.row.replaceWith(fresh);markRow(fresh);lay();
var n=fresh.querySelector('.anote[data-note="'+d.note+'"]');if(n){n.classList.add('flash');setTimeout(function(){n.classList.remove('flash')},1600)}}).catch(function(){wait.classList.add('err');wait.querySelector('.nt').textContent='Не вийшло. Спробуйте ще раз.'})});
body.addEventListener('click',function(e){var h=e.target.closest('mark.hl');if(h&&getSelection().isCollapsed&&bubble.querySelector('[data-unsave]')){unsel=h.dataset.hl;sel=null;mode(true);show(h.getBoundingClientRect())}
var m=e.target.closest('mark.ex');if(m){var row=m.closest('.arow-b');if(phone())row.classList.toggle('open');var n=row.querySelector('.anote[data-note="'+m.dataset.note+'"]');if(n){n.classList.add('flash','full');setTimeout(function(){n.classList.remove('flash')},1600)}return}
var nt=e.target.closest('.anote .nt');if(nt&&!e.target.closest('a')){nt.parentNode.classList.toggle('full');lay()}});
${HL_JS}
})();`;

module.exports = { indexPage, articlePage, highlightsPage, blockHtml, noteHtml };
