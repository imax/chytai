// Android's own font size (Settings → Display → Font size) for the page (bug №24, Max 2026-11-22: variant A).
// Android's WebView grows only the letters by it (text zoom): icons, buttons, covers and sheets stayed as they were,
// so text overflowed and icons looked tiny. App.js turns that off (textZoom 100) and this script, injected before
// the page loads, zooms the whole page by the same factor instead, as Chrome on Android does: the viewport gets
// narrower in CSS pixels (411 px / 1.3 = 316 px) and everything is drawn bigger. Pages read the factor as
// window.__chytaiZoom. Plain ES5: it runs inside the page.
export const MAX_ZOOM = 1.5;

export function zoomScript(fontScale) {
  const s = Math.round(Math.min(MAX_ZOOM, Math.max(0.85, Number(fontScale) || 1)) * 100) / 100;
  return `
  (function () {
    var s = ${s};
    window.__chytaiZoom = s;
    if (s === 1) return;
    var done = false;
    var fix = function () {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m || done) return !!m;
      // The screen's width in CSS pixels (the app is portrait only); an old WebView gave device pixels.
      var sw = screen.width;
      if (sw > 800 && window.devicePixelRatio > 1) sw = sw / window.devicePixelRatio;
      if (!sw) return false;
      var w = Math.round(sw / s);
      var k = Math.round((sw / w) * 1000) / 1000;
      var fit = /viewport-fit=cover/.test(m.content) ? ', viewport-fit=cover' : '';
      m.content = 'width=' + w + ', initial-scale=' + k + ', minimum-scale=' + k + ', maximum-scale=' + k + ', user-scalable=no' + fit;
      done = true;
      return true;
    };
    if (!fix()) {
      var mo = new MutationObserver(function () { if (fix()) mo.disconnect(); });
      mo.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', function () { fix(); mo.disconnect(); });
    }
  })();
  true;
`;
}
