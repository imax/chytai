// Dictation (paper books v3, e-books since 2026-11-03): the browser's speech recognition into a question or note
// field, then the words tidied into sentences by the server (punctuation, capitals, «titles», misheard words).
// Fields are named by id: the paper page redraws its HTML, so a field found again by id still gets the words.
/* global showNotice */
(() => {
  const $ = (s) => document.querySelector(s);
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  // An iPhone app built without the microphone permission would close on it.
  const MIC_OK = !!Speech && (!/ChytaiApp/.test(navigator.userAgent) || /ChytaiApp\/camera\/mic/.test(navigator.userAgent));
  let listening = null;

  const lit = (on) => {
    document.querySelectorAll(".pp-tool.on").forEach((b) => b.classList.remove("on"));
    if (on) $(on)?.classList.add("on");
  };

  // id: the field; button: a selector for the mic button that lights up while listening;
  // tidy(text) -> Promise<text>: how to tidy the words (none: they stay as heard).
  function toggle(id, button, tidy) {
    if (listening) {
      const was = listening.field;
      listening.stop();
      if (was === id) return;
    }
    if (!MIC_OK) return showNotice("Тут диктувати можна мікрофоном на клавіатурі.", false), $(`#${id}`)?.focus();
    const field = $(`#${id}`);
    if (!field) return;
    const start = field.value.trim() ? `${field.value.trim()} ` : "";
    const rec = new Speech();
    rec.lang = "uk-UA";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && showNotice(e.error === "not-allowed" ? "Немає доступу до мікрофона." : "Не вдалося розпізнати мовлення.", false);
    let said = "";
    rec.onresult = (e) => {
      said = [...e.results].map((r) => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      const f = $(`#${id}`);
      if (f) (f.value = start + said), f.dispatchEvent(new Event("input", { bubbles: true }));
    };
    rec.onend = () => {
      if (listening === rec) (listening = null), lit(null);
      tidyField(id, start, said, tidy);
    };
    try {
      rec.start();
      rec.field = id;
      listening = rec;
      lit(button);
    } catch {
      showNotice("Не вдалося увімкнути мікрофон.", false);
    }
  }

  // The field changes only if nobody typed in it meanwhile.
  async function tidyField(id, start, said, tidy) {
    const field = $(`#${id}`);
    if (!tidy || !said || !field || said.split(" ").length < 2) return;
    field.classList.add("pp-tidying");
    let text = said;
    try {
      text = (await tidy(said)) || said;
    } catch {
      /* the words as heard will do */
    }
    const now = $(`#${id}`);
    now?.classList.remove("pp-tidying");
    if (now && now.value === start + said) (now.value = start + text), now.dispatchEvent(new Event("input", { bubbles: true }));
  }

  window.Dictation = {
    toggle,
    stop: () => listening?.stop(),
    field: () => listening?.field || "",
  };
})();
