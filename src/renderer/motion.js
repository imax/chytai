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
