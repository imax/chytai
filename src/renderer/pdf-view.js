// PDF support on top of pdf.js: continuous pages with a selectable text layer.
import * as pdfjsLib from "../../node_modules/pdfjs-dist/build/pdf.mjs";
import { pdfToEpub, REFLOW_VERSION } from "./pdf-reflow.js";

globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;

const viewerLib = import("../../node_modules/pdfjs-dist/web/pdf_viewer.mjs");

const NEARBY_PAGES = 1; // pages on each side used as context for an explanation
const BEFORE_CHARS = 2000;
const AFTER_CHARS = 1000;

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

class PdfView {
  static REFLOW_VERSION = REFLOW_VERSION;

  // Text-mode conversion: returns { epub: ArrayBuffer } or throws Error("NO_TEXT") for scans.
  static async reflow(data, onProgress) {
    const task = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
    try {
      const doc = await task.promise;
      const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
      const meta = { title: clean(info?.Title) || "", author: clean(info?.Author), language: clean(info?.Language).slice(0, 5) };
      return await pdfToEpub(doc, meta, onProgress);
    } finally {
      task.destroy();
    }
  }

  static async open(container, data, { position, onPageChange }) {
    const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await viewerLib;
    const view = new PdfView();
    view.container = container;
    view.eventBus = new EventBus();
    view.linkService = new PDFLinkService({ eventBus: view.eventBus });
    view.findController = new PDFFindController({ eventBus: view.eventBus, linkService: view.linkService });
    view.viewer = new PDFViewer({
      findController: view.findController,
      container,
      eventBus: view.eventBus,
      linkService: view.linkService,
      textLayerMode: 1,
      removePageBorders: true,
    });
    view.linkService.setViewer(view.viewer);
    view.pageText = new Map();

    view.loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
    view.doc = await view.loadingTask.promise;
    view.viewer.setDocument(view.doc);
    view.linkService.setDocument(view.doc);

    await new Promise((resolve) => view.eventBus.on("pagesinit", resolve, { once: true }));
    view.viewer.currentScaleValue = "page-width";
    const page = /^pdf:(\d+)$/.exec(position || "");
    if (page) view.viewer.currentPageNumber = Math.min(Number(page[1]), view.doc.numPages);

    view.eventBus.on("pagechanging", (e) => onPageChange?.(e.pageNumber, view.doc.numPages));
    onPageChange?.(view.viewer.currentPageNumber, view.doc.numPages);
    return view;
  }

  async metadata() {
    const { info } = await this.doc.getMetadata().catch(() => ({ info: {} }));
    return { title: clean(info?.Title), author: clean(info?.Author) };
  }

  // Flattened outline in the same shape as epub.js navigation: { label, href, subitems }.
  async toc() {
    const outline = (await this.doc.getOutline()) || [];
    const map = (items) => items.map((i) => ({ label: i.title, href: i.dest, subitems: map(i.items || []) }));
    return map(outline);
  }

  goTo(dest) {
    this.linkService.goToDestination(dest);
  }

  next() {
    this.viewer.nextPage();
  }

  prev() {
    this.viewer.previousPage();
  }

  get page() {
    return this.viewer.currentPageNumber;
  }

  setZoom(percent) {
    // 100% in the app's font control maps to fitting the page width.
    this.viewer.currentScaleValue = "page-width";
    this.viewer.currentScale = this.viewer.currentScale * (percent / 100);
  }

  resize() {
    const value = this.viewer.currentScaleValue;
    this.viewer.currentScaleValue = value;
  }

  async textOfPage(n) {
    if (!this.pageText.has(n)) {
      const content = await (await this.doc.getPage(n)).getTextContent();
      this.pageText.set(n, content.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join(""));
    }
    return this.pageText.get(n);
  }

  pageOfNode(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const pageEl = el?.closest(".page");
    return pageEl ? Number(pageEl.dataset.pageNumber) : this.page;
  }

  // Selection text plus the surrounding page text, matching what context.js returns for EPUB.
  async extractContext(range) {
    const selection = clean(range.toString());
    const page = this.pageOfNode(range.startContainer);
    const from = Math.max(1, page - NEARBY_PAGES);
    const to = Math.min(this.doc.numPages, page + NEARBY_PAGES);
    const texts = [];
    for (let n = from; n <= to; n++) texts.push(clean(await this.textOfPage(n)));
    const all = texts.join(" ");
    // Offset of the selected page inside the joined text, so a repeated phrase resolves to this page.
    const pageStart = texts.slice(0, page - from).reduce((sum, t) => sum + t.length + 1, 0);
    let at = all.indexOf(selection, pageStart);
    if (at < 0) at = all.indexOf(selection);
    if (at < 0) return { selection, before: all.slice(Math.max(0, pageStart - BEFORE_CHARS), pageStart + 1500), after: "", page };
    return {
      selection,
      before: all.slice(Math.max(0, at - BEFORE_CHARS), at),
      after: all.slice(at + selection.length, at + selection.length + AFTER_CHARS),
      page,
    };
  }

  // Full-text search over every page; calls onResult({ page, excerpt, index }) as matches are found.
  async search(query, onResult, isCancelled) {
    const q = query.toLowerCase();
    for (let n = 1; n <= this.doc.numPages; n++) {
      if (isCancelled()) return;
      const text = clean(await this.textOfPage(n));
      const lower = text.toLowerCase();
      let index = 0;
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
        onResult({ page: n, index: index++, excerpt: text.slice(Math.max(0, at - 60), at + q.length + 60), at: Math.min(60, at) });
      }
    }
  }

  // Highlights all matches on the rendered pages and scrolls to the given page.
  showMatch(query, page) {
    this.viewer.currentPageNumber = page;
    this.eventBus.dispatch("find", { source: this, type: "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
  }

  clearMatches() {
    this.eventBus.dispatch("findbarclose", { source: this });
  }

  destroy() {
    this.viewer.setDocument(null);
    this.linkService.setDocument(null);
    // In pdf.js 6 the document is released through its loading task.
    this.loadingTask.destroy();
    this.container.querySelector(".pdfViewer").innerHTML = "";
  }
}

window.PdfView = PdfView;
