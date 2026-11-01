// Free-to-read texts on their publisher's own site, put by hand into «Де взяти» («Інше»): the book is still under
// copyright and is not a file on the free shelf, only a link to where its owner lets everyone read it.
// Max, 2026-11-01: The Feynman Lectures on Physics, all three volumes, on Caltech's site.
const LINKS = {
  "the-feynman-lectures-on-physics": { label: "Caltech, читати онлайн", url: "https://www.feynmanlectures.caltech.edu/" },
};

const linkFor = (store, book) => (book && (LINKS[store.canonical(book.id)] || LINKS[book.id])) || null;

module.exports = { linkFor };
