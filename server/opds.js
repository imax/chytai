// OPDS catalog of one reader's books, for e-ink readers (Max's XT-Ink with CrossPoint, 2026-11-05).
// Atom/OPDS 1.2: one acquisition feed, newest-read first, a page at a time (CrossPoint keeps up to
// 62 entries of a feed), with search. Links are absolute paths: CrossPoint joins relative ones with "/".

const PAGE = 25;

const xml = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const iso = (ms) => new Date(ms || Date.now()).toISOString();
const FEED = "application/atom+xml;profile=opds-catalog;kind=acquisition";

// books: [{ id, title, authors, at, cover }] already sorted. base: "/opds/<token>".
function feed({ base, books, page, q, updated }) {
  const pages = Math.max(1, Math.ceil(books.length / PAGE));
  const p = Math.min(Math.max(1, page || 1), pages);
  const qs = (n) => `${base}?${q ? `q=${encodeURIComponent(q)}&amp;` : ""}page=${n}`;
  const entries = books.slice((p - 1) * PAGE, p * PAGE).map((b) => `
  <entry>
    <title>${xml(b.title)}</title>
    ${(b.authors || []).map((a) => `<author><name>${xml(a)}</name></author>`).join("")}
    <id>urn:chytai:book:${b.id}</id>
    <updated>${iso(b.at)}</updated>
    ${b.cover ? `<link rel="http://opds-spec.org/image" href="${base}/cover/${b.id}" type="${b.cover}"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${base}/cover/${b.id}" type="${b.cover}"/>` : ""}
    <link rel="http://opds-spec.org/acquisition/open-access" href="${base}/book/${b.id}.epub" type="application/epub+zip"/>
  </entry>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>urn:chytai:opds${q ? `:search:${xml(q)}` : ""}:${p}</id>
  <title>${q ? `Пошук: ${xml(q)}` : "Мої книжки · Chytai"}</title>
  <updated>${iso(updated)}</updated>
  <author><name>Chytai</name><uri>https://chytai.org.ua</uri></author>
  <opensearch:totalResults>${books.length}</opensearch:totalResults>
  <opensearch:itemsPerPage>${PAGE}</opensearch:itemsPerPage>
  <opensearch:startIndex>${(p - 1) * PAGE + 1}</opensearch:startIndex>
  <link rel="self" href="${qs(p)}" type="${FEED}"/>
  <link rel="start" href="${base}" type="${FEED}"/>
  <link rel="search" href="${base}?q={searchTerms}" type="${FEED}"/>
  ${p > 1 ? `<link rel="first" href="${qs(1)}" type="${FEED}"/><link rel="previous" href="${qs(p - 1)}" type="${FEED}"/>` : ""}
  ${p < pages ? `<link rel="next" href="${qs(p + 1)}" type="${FEED}"/><link rel="last" href="${qs(pages)}" type="${FEED}"/>` : ""}${entries.join("")}
</feed>
`;
}

// Title or author holds every word of the query, case and apostrophes aside.
function search(books, q) {
  const norm = (s) => String(s).toLowerCase().normalize("NFC").replace(/[’'ʼ`]/g, "");
  const words = norm(q).split(/\s+/).filter(Boolean);
  return books.filter((b) => {
    const hay = norm(`${b.title} ${(b.authors || []).join(" ")}`);
    return words.every((w) => hay.includes(w));
  });
}

module.exports = { feed, search, FEED, PAGE };
