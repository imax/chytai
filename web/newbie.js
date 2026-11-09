// The newcomer's day-2 letter (Max, 2026-11-09: «про новачку лист на другий день. попросити його оцінити хоча б
// три книжки»): six books most readers here have read, each with five star links. One tap = /do/rate/<book>/<n>,
// the book is on the shelf as read with that rating, and /start shows the rest. Sent through the shared letter
// shell with kind "newbie", so it is in the send log and counts toward the two-a-day cap (maillog.js).
const M = require("./mailhtml");

const SUBJECT = "Оцініть три книжки";

// `books`: [{ title, author, cover, href, slug }]. `link(path)` turns a site path into a tracked URL.
function compose({ site, reader, books, link = (p) => site + p }) {
  const star = (slug, n) => `<a href="${M.esc(link(`/do/rate/${encodeURIComponent(slug)}/${n}`))}" title="${n} з 5" style="color:#c9c2b4;text-decoration:none;font-size:24px;line-height:1;padding:0 3px">★</a>`;
  const rows = books.map((b) => M.book({ ...b, note: `<div style="margin-top:6px;white-space:nowrap">${[1, 2, 3, 4, 5].map((n) => star(b.slug, n)).join("")}</div>` }, site)).join("");
  const html = M.letter({
    site,
    title: SUBJECT,
    heading: "Що з цього ви читали?",
    body: `${M.paras("Оцініть хоча б три, і ми підберемо, що читати далі.")}${rows}`,
    button: { text: "Більше книжок", href: link("/start") },
  });
  const text = [
    "Що з цього ви читали?",
    "",
    "Оцініть хоча б три книжки, і ми підберемо, що читати далі.",
    "",
    ...books.map((b) => `«${b.title}»${b.author ? `, ${b.author}` : ""}`),
    "",
    `Оцінити: ${link("/start")}`,
  ].join("\n");
  return { subject: SUBJECT, html, text };
}

module.exports = { compose, SUBJECT };
