// Pulls the text around a selection out of the chapter document so the model sees it in context.
(function (global) {
  const BLOCKS = "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, dd, dt, figcaption, td, th";
  const BEFORE_CHARS = 2000;
  const AFTER_CHARS = 1000;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Leaf-level text blocks in document order (a <li> wrapping a <p> counts once).
  function textBlocks(doc) {
    return Array.from(doc.body.querySelectorAll(BLOCKS)).filter(
      (el) => !el.querySelector(BLOCKS) && clean(el.textContent)
    );
  }

  function blockIndexOf(blocks, node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] === el || blocks[i].contains(el)) return i;
    }
    // Node sits between blocks: take the last block that precedes it.
    let idx = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) idx = i;
    }
    return idx;
  }

  function collect(blocks, from, step, limit) {
    const out = [];
    let len = 0;
    for (let i = from; i >= 0 && i < blocks.length && len < limit; i += step) {
      const t = clean(blocks[i].textContent);
      out.push(t);
      len += t.length;
    }
    if (step < 0) out.reverse();
    let text = out.join("\n\n");
    if (text.length > limit) text = step < 0 ? "…" + text.slice(-limit) : text.slice(0, limit) + "…";
    return text;
  }

  function extractContext(doc, range) {
    const selection = (range.toString() || "").trim();
    const blocks = textBlocks(doc);
    let startIdx = blockIndexOf(blocks, range.startContainer);
    let endIdx = blockIndexOf(blocks, range.endContainer);

    if (blocks.length && startIdx >= 0) {
      if (endIdx < startIdx) endIdx = startIdx;
      // Text of the selected block(s) that falls before and after the selection itself.
      const pre = doc.createRange();
      pre.setStart(blocks[startIdx], 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const post = doc.createRange();
      post.setStart(range.endContainer, range.endOffset);
      post.setEnd(blocks[endIdx], blocks[endIdx].childNodes.length);

      const before = [collect(blocks, startIdx - 1, -1, BEFORE_CHARS), clean(pre.toString())]
        .filter(Boolean)
        .join("\n\n");
      const after = [clean(post.toString()), collect(blocks, endIdx + 1, 1, AFTER_CHARS)]
        .filter(Boolean)
        .join("\n\n");
      return { selection, before, after };
    }

    // Books without paragraph markup: fall back to the raw chapter text.
    const all = clean(doc.body.textContent);
    const at = all.indexOf(clean(selection));
    if (at < 0) return { selection, before: all.slice(0, BEFORE_CHARS), after: "" };
    return {
      selection,
      before: all.slice(Math.max(0, at - BEFORE_CHARS), at),
      after: all.slice(at + clean(selection).length, at + clean(selection).length + AFTER_CHARS),
    };
  }

  global.extractContext = extractContext;
  if (typeof module !== "undefined") module.exports = { extractContext };
})(typeof window !== "undefined" ? window : globalThis);
