// Smooth open and close for dialogs, and quick tooltips for mouse users.
// Loaded before renderer.js; works on whatever <dialog> and [title] elements the page has.

(() => {
  // ---------- Dialogs ----------
  // A dialog plays its closing animation (dialog.closing in style.css) before it really closes, whether
  // it closes from a form button, Esc, a tap on the dimmed backdrop, or code calling dialog.close().
  const nativeClose = HTMLDialogElement.prototype.close;

  function animateClose(dialog, value) {
    if (!dialog.open || dialog.classList.contains("closing")) return;
    dialog.classList.add("closing");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog.classList.remove("closing");
      nativeClose.call(dialog, value);
      dialog.style.transform = dialog.style.transition = ""; // left by a swipe down

    };
    dialog.addEventListener("animationend", (e) => e.target === dialog && finish());
    setTimeout(finish, 320); // in case the animation never runs (hidden tab, reduced motion quirks)
  }

  function setup(dialog) {
    dialog.close = (value) => animateClose(dialog, value);
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      animateClose(dialog, "cancel");
    });
    dialog.addEventListener("submit", (e) => {
      if (e.target.method !== "dialog") return;
      e.preventDefault();
      animateClose(dialog, e.submitter?.value ?? "");
    });
    // A tap on the backdrop is a click on the dialog element itself, outside its box.
    let downOnBackdrop = false;
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    dialog.addEventListener("pointerdown", (e) => (downOnBackdrop = outside(e)));
    dialog.addEventListener("click", (e) => {
      if (downOnBackdrop && outside(e)) animateClose(dialog, "cancel");
      downOnBackdrop = false;
    });
    swipe(dialog);
  }

  // On a phone a dialog is a sheet at the bottom edge (style.css), and a swipe down closes it (Max 2026-11-26).
  // The drag starts only with the sheet scrolled to its top, never in a field or a row that scrolls sideways;
  // a short or slow pull springs back.
  const phone = matchMedia("(max-width: 760px)");
  function swipe(dialog) {
    let x0 = 0, y0 = 0, yl = 0, tl = 0, v = 0, dy = 0, on = false, drag = false;
    const sideways = (el) => {
      for (; el && el !== dialog; el = el.parentElement)
        if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
      return false;
    };
    dialog.addEventListener("touchstart", (e) => {
      on = drag = false;
      if (!phone.matches || e.touches.length > 1 || dialog.scrollTop > 0 || dialog.classList.contains("closing")) return;
      if (dialog.getBoundingClientRect().bottom < innerHeight - 4) return; // not a sheet
      if (e.target.closest?.("input, textarea, select, [contenteditable]") || sideways(e.target)) return;
      const t = e.touches[0];
      x0 = t.clientX; y0 = yl = t.clientY; tl = performance.now(); v = dy = 0; on = true;
    }, { passive: true });
    dialog.addEventListener("touchmove", (e) => {
      if (!on) return;
      const t = e.touches[0];
      if (!drag) {
        const d = t.clientY - y0, dx = t.clientX - x0;
        if (Math.abs(d) < 8 && Math.abs(dx) < 8) return;
        if (d <= 0 || Math.abs(dx) > d || dialog.scrollTop > 0) return void (on = false);
        drag = true;
        y0 = t.clientY;
        dialog.style.transition = "none";
      }
      e.preventDefault();
      const now = performance.now();
      v = (t.clientY - yl) / Math.max(1, now - tl);
      yl = t.clientY; tl = now;
      dy = Math.max(0, t.clientY - y0);
      dialog.style.transform = `translateY(${dy}px)`;
    }, { passive: false });
    const end = (e) => {
      if (!drag) return void (on = false);
      on = drag = false;
      if (e.type === "touchend" && (dy > Math.min(120, dialog.offsetHeight / 4) || (v > 0.4 && dy > 24))) {
        animateClose(dialog, "cancel");
        return;
      }
      dialog.style.transition = "transform 0.2s var(--ease-out)";
      dialog.style.transform = "";
      setTimeout(() => !drag && (dialog.style.transition = ""), 220);
    };
    dialog.addEventListener("touchend", end);
    dialog.addEventListener("touchcancel", end);
  }

  const init = () => document.querySelectorAll("dialog").forEach(setup);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // ---------- Tooltips ----------
  // The browser's own title tooltips wait a second and a half and look like a system dialog. With a
  // mouse, show the same text right next to the button instead; touch screens never had tooltips.
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  let tip = null;
  let target = null;
  let timer = 0;
  let lastHidden = 0;

  function show(el) {
    const text = el.dataset.tip;
    if (!text) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "tip";
      tip.setAttribute("role", "tooltip");
    }
    // An open dialog sits in the top layer, above anything in the page, so its tips must live in it.
    const host = el.closest("dialog") || document.body;
    if (tip.parentNode !== host) host.appendChild(tip);
    tip.textContent = text;
    tip.classList.remove("shown");
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 4) top = r.top - h - 6;
    const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    requestAnimationFrame(() => tip?.classList.add("shown"));
  }

  function hide() {
    clearTimeout(timer);
    if (target) lastHidden = Date.now();
    target = null;
    tip?.classList.remove("shown");
  }

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[title], [data-tip]");
    if (el === target) return;
    hide();
    if (!el) return;
    // Take the text over from the title (code may set a new title at any time), so the system
    // tooltip never shows as well. Icon-only buttons keep it as their accessible name.
    if (el.title) {
      el.dataset.tip = el.title;
      if (!el.textContent.trim() || /^[^\p{L}\p{N}]+$/u.test(el.textContent.trim())) el.setAttribute("aria-label", el.title);
      el.removeAttribute("title");
    }
    target = el;
    // Moving from one button to the next shows the next tip at once, like the macOS menu bar.
    timer = setTimeout(() => target === el && show(el), Date.now() - lastHidden < 600 ? 0 : 450);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
})();
