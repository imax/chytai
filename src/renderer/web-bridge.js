// In the browser (phone, web) there is no Electron preload, so this file provides the same
// window.reader bridge over HTTP to server/index.js. In Electron window.reader already exists.
(() => {
  // (window.reader is also the <section id="reader"> element until a bridge is assigned.)
  if (typeof window.reader?.getSettings === "function") return;
  document.body.classList.add("web");

  // pdf.js 6 uses the new Map "upsert" methods; older mobile browsers don't have them yet.
  for (const proto of [Map.prototype, WeakMap.prototype]) {
    proto.getOrInsert ??= function (key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
    proto.getOrInsertComputed ??= function (key, compute) {
      if (!this.has(key)) this.set(key, compute(key));
      return this.get(key);
    };
  }

  const listeners = {};
  const on = (name) => (cb) => (listeners[name] ??= []).push(cb);
  const emit = (name, ...args) => (listeners[name] || []).forEach((cb) => cb(...args));
  const streams = new Map(); // request id -> AbortController
  let firstLoadDone = false;

  async function api(method, url, body, opts = {}) {
    const headers = {};
    if (body !== undefined && !(body instanceof Blob || body instanceof ArrayBuffer)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body, credentials: "same-origin", ...opts });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("login");
    }
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (await res.json()).error || message;
      } catch {
        /* not json */
      }
      throw new Error(message);
    }
    return res;
  }

  // Reading positions change on every page turn; batch them a little.
  const pendingPositions = new Map();
  let positionTimer = null;
  function flushPositions(keepalive) {
    clearTimeout(positionTimer);
    for (const [path, cfi] of pendingPositions) {
      fetch("/api/position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, cfi }),
        credentials: "same-origin",
        keepalive,
      }).catch(() => {});
    }
    pendingPositions.clear();
  }
  window.addEventListener("pagehide", () => flushPositions(true));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushPositions(true));

  async function openServerBook(name) {
    try {
      const res = await api("GET", `/api/book?path=${encodeURIComponent(name)}`);
      const data = await res.arrayBuffer();
      const position = decodeURIComponent(res.headers.get("X-Book-Position") || "") || null;
      const reflowPosition = decodeURIComponent(res.headers.get("X-Book-Reflow-Position") || "") || null;
      emit("book:open", { path: name, name, data, position, reflowPosition });
    } catch (err) {
      if (err.message !== "login") emit("book:error", `Не вдалося відкрити книжку: ${err.message}`);
    }
  }

  async function uploadAndOpen(file) {
    if (!/\.(epub|pdf)$/i.test(file.name)) {
      return emit("book:error", "На телефоні підтримуються EPUB і PDF. Інші формати спершу відкрийте на Mac, він конвертує їх через Calibre.");
    }
    if (typeof showNotice === "function") showNotice(`Завантажую «${file.name}» на сервер…`, true);
    try {
      const res = await api("PUT", `/api/books/${encodeURIComponent(file.name)}`, file);
      const { path } = await res.json();
      await openServerBook(path);
    } catch (err) {
      if (err.message !== "login") emit("book:error", `Не вдалося завантажити книжку: ${err.message}`);
    }
  }

  function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,.pdf,application/epub+zip,application/pdf";
    input.onchange = () => input.files[0] && uploadAndOpen(input.files[0]);
    input.click();
  }

  window.reader = {
    chooseBook: () => pickFile(),
    // Drag & drop and the file picker hand over a File; library entries hand over a name.
    pathForFile: (file) => file,
    openPath: (target) => (target instanceof File ? uploadAndOpen(target) : openServerBook(target)),
    savePosition: (bookPath, cfi) => {
      pendingPositions.set(bookPath, cfi);
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => flushPositions(false), 600);
    },
    reflowGet: async (bookPath, version) => {
      const res = await api("GET", `/api/reflow?path=${encodeURIComponent(bookPath)}&version=${encodeURIComponent(version)}`);
      return res.status === 204 ? null : res.arrayBuffer();
    },
    reflowPut: (bookPath, version, data) =>
      api("PUT", `/api/reflow?path=${encodeURIComponent(bookPath)}&version=${encodeURIComponent(version)}`, new Blob([data])).catch(() => {}),
    libraryList: () => api("GET", "/api/library").then((r) => r.json()),
    libraryAddFolder: async () => {
      pickFile();
      return false;
    },
    libraryRemoveFolder: async () => {},
    getSettings: async () => {
      const settings = await (await api("GET", "/api/settings")).json();
      // Electron reopens the last book after the window loads; here the bridge does it.
      if (!firstLoadDone) {
        firstLoadDone = true;
        if (settings.lastBook) setTimeout(() => openServerBook(settings.lastBook), 0);
      }
      return settings;
    },
    setSettings: (patch) => api("PATCH", "/api/settings", patch).then((r) => r.json()),
    explain: async (id, request) => {
      const controller = new AbortController();
      streams.set(id, controller);
      const send = (payload) => emit("ai:event", id, payload);
      try {
        const res = await api("POST", "/api/explain", { request }, { signal: controller.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) send(JSON.parse(line));
          }
        }
        if (buf.trim()) send(JSON.parse(buf));
      } catch (err) {
        if (controller.signal.aborted) send({ type: "aborted" });
        else if (err.message !== "login") send({ type: "error", message: err.message === "Failed to fetch" ? "Немає з'єднання з сервером." : err.message });
      } finally {
        streams.delete(id);
      }
    },
    abort: (id) => streams.get(id)?.abort(),
    onBookOpen: on("book:open"),
    onBookConverting: on("book:converting"),
    onBookError: on("book:error"),
    onAiEvent: on("ai:event"),
    onShowSettings: on("ui:settings"),
    onShowLibrary: on("ui:library"),
    onTogglePanel: on("ui:toggle-panel"),
    onFind: on("ui:find"),
    logout: () => {
      const f = document.createElement("form");
      f.method = "post";
      f.action = "/logout";
      document.body.appendChild(f);
      f.submit();
    },
  };

  // Keyboard shortcuts the Electron menu used to provide.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "o") (e.preventDefault(), pickFile());
    else if (k === "l") (e.preventDefault(), emit("ui:library"));
    else if (k === "e") (e.preventDefault(), emit("ui:toggle-panel"));
    else if (k === ",") (e.preventDefault(), emit("ui:settings"));
    else if (k === "f") (e.preventDefault(), emit("ui:find", "open"));
    else if (k === "g") (e.preventDefault(), emit("ui:find", e.shiftKey ? "prev" : "next"));
  });

  // Web-only labels.
  const libAdd = document.getElementById("lib-add");
  if (libAdd) {
    libAdd.textContent = "Додати книжку…";
    libAdd.title = "Завантажити EPUB або PDF у спільну бібліотеку";
  }
})();
