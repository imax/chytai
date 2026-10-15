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

  // ---------- Offline: what the device keeps, and the changes waiting for the network ----------
  //
  // The service worker (sw.js) keeps the reader itself. Here IndexedDB keeps the books opened on this
  // device, the settings (with reading positions), the library list and the notes of each book, so all of
  // it opens without a network. Changes made offline (a note, a comment, a position, a setting) are
  // written locally at once and queued; the queue is sent as soon as a request succeeds again.
  // Explanations and translations need Claude, so they only work online.

  const isNetworkError = (err) => err instanceof TypeError; // fetch() itself failed; HTTP errors are plain Errors

  const dbReady = new Promise((resolve) => {
    let open;
    try {
      open = indexedDB.open("chytai", 1);
    } catch {
      return resolve(null);
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("books"); // book path -> { data, savedAt }; also "<path>#reflow@<version>" for converted PDFs
      db.createObjectStore("kv"); // settings, library, notes:<path>, positions, noteIds
      db.createObjectStore("queue", { autoIncrement: true }); // changes waiting for the network, oldest first
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
  });
  async function idb(store, mode, fn) {
    const db = await dbReady;
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const kvGet = (key) => idb("kv", "readonly", (s) => s.get(key)).catch(() => undefined);
  const kvSet = (key, value) => idb("kv", "readwrite", (s) => s.put(value, key)).catch(() => {});

  let offline = false;
  function setOffline(value) {
    if (offline === value) return;
    offline = value;
    document.body.classList.toggle("offline", value);
    if (typeof toast === "function") toast(value ? "Немає з'єднання: читаємо з пристрою" : "З'єднання відновлено");
    if (!value) sync();
  }
  // Settings as last seen, with the changes made here; the server's copy catches up through the queue.
  let cachedSettings = null;
  async function localSettings() {
    return (cachedSettings ??= (await kvGet("settings")) || null);
  }
  async function patchLocalSettings(patch) {
    cachedSettings = { ...((await localSettings()) || {}), ...patch };
    await kvSet("settings", cachedSettings);
    return cachedSettings;
  }
  async function rememberPosition(path, cfi) {
    const s = (await localSettings()) || {};
    await patchLocalSettings({ positions: { ...(s.positions || {}), [path]: cfi } });
  }

  const enqueue = (item) => idb("queue", "readwrite", (s) => s.add(item)).catch(() => {});
  const noteIds = new Map(); // id given here while offline -> id the server gave it once synced
  const serverNoteId = (id) => noteIds.get(id) || id;

  // The queued changes, oldest first; stops at the first network failure and drops what the server refused.
  let syncing = null;
  function sync() {
    return (syncing ??= (async () => {
      try {
        const positions = (await kvGet("positions")) || {};
        for (const [path, cfi] of Object.entries(positions)) {
          await api("PUT", "/api/position", { path, cfi });
          delete positions[path];
          await kvSet("positions", positions);
        }
        for (;;) {
          const [keys, items] = await Promise.all([idb("queue", "readonly", (s) => s.getAllKeys()), idb("queue", "readonly", (s) => s.getAll())]);
          if (!keys?.length) break;
          try {
            await perform(items[0]);
          } catch (err) {
            if (isNetworkError(err) || err.message === "login") return;
            console.warn("sync: dropped", items[0], err);
          }
          await idb("queue", "readwrite", (s) => s.delete(keys[0]));
        }
      } catch (err) {
        if (!isNetworkError(err)) console.warn("sync failed", err);
      } finally {
        syncing = null;
      }
    })());
  }
  async function perform(item) {
    if (item.type === "settings") await api("PATCH", "/api/settings", item.patch);
    else if (item.type === "noteAdd") {
      const { note } = await (await api("POST", "/api/notes", { ...item.note, id: undefined, path: item.path })).json();
      noteIds.set(item.note.id, note.id);
      // Later changes to that note, queued or still to come from the page, must name the server's id.
      const [keys, items] = await Promise.all([idb("queue", "readonly", (s) => s.getAllKeys()), idb("queue", "readonly", (s) => s.getAll())]);
      for (const [i, other] of items.entries()) {
        if (other.id === item.note.id) await idb("queue", "readwrite", (s) => s.put({ ...other, id: note.id }, keys[i]));
      }
      await cacheNotes(item.path, (list) => list.map((n) => (n.id === item.note.id ? { ...n, id: note.id } : n)));
      if (item.note.comment) await api("PATCH", `/api/notes/${encodeURIComponent(note.id)}?path=${encodeURIComponent(item.path)}`, { comment: item.note.comment });
    } else if (item.type === "noteUpdate") await api("PATCH", `/api/notes/${encodeURIComponent(item.id)}?path=${encodeURIComponent(item.path)}`, item.patch);
    else if (item.type === "noteDelete") await api("DELETE", `/api/notes/${encodeURIComponent(item.id)}?path=${encodeURIComponent(item.path)}`);
  }
  async function cacheNotes(bookPath, update) {
    const list = update((await kvGet(`notes:${bookPath}`)) || []);
    await kvSet(`notes:${bookPath}`, list);
    return list;
  }
  // Drops a note that only ever existed on this device, together with the changes queued for it.
  async function unqueueNote(id) {
    const [keys, items] = await Promise.all([idb("queue", "readonly", (s) => s.getAllKeys()), idb("queue", "readonly", (s) => s.getAll())]);
    for (const [i, item] of (items || []).entries()) {
      if (item.id === id || item.note?.id === id) await idb("queue", "readwrite", (s) => s.delete(keys[i]));
    }
  }

  window.addEventListener("online", () => sync());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sync());

  // The reader's own files stay on the device through the service worker. A new version installed by a
  // deploy waits (sw.js) until the page is hidden or no book is open, then takes over with a reload, so
  // the book being read never mixes two versions of the scripts.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const swap = () => reg.waiting?.postMessage("skipWaiting");
        const whenIdle = () => (document.hidden || typeof current === "undefined" || !current) && swap();
        reg.addEventListener("updatefound", () => reg.installing?.addEventListener("statechange", whenIdle));
        // The browser looks for a new sw.js only on a navigation, and the app never navigates: the
        // page lives for days. So the check is made whenever the app goes to the background or comes
        // back, and when the network returns; a version found in the background takes over there.
        const check = () => reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => (check(), whenIdle()));
        window.addEventListener("online", check);
        whenIdle();
      })
      .catch((err) => console.warn("service worker", err));
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !streams.size) location.reload();
      hadController = true;
    });
  }

  async function api(method, url, body, opts = {}) {
    const headers = {};
    if (body !== undefined && !(body instanceof Blob || body instanceof ArrayBuffer)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body, credentials: "same-origin", ...opts });
    } catch (err) {
      if (isNetworkError(err)) setOffline(true);
      throw err;
    }
    setOffline(false);
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
      rememberPosition(path, cfi);
      fetch("/api/position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, cfi }),
        credentials: "same-origin",
        keepalive,
      })
        .then(() => setOffline(false))
        .catch(async () => {
          // No network: the position waits in IndexedDB (one per book, the latest wins) for the next sync.
          setOffline(true);
          await kvSet("positions", { ...((await kvGet("positions")) || {}), [path]: cfi });
        });
    }
    pendingPositions.clear();
  }
  window.addEventListener("pagehide", () => flushPositions(true));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushPositions(true));

  function afterLoad(fn) {
    const go = () => requestAnimationFrame(() => setTimeout(fn, 0));
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
  }

  async function openServerBook(name) {
    let payload;
    try {
      await sync(); // positions saved here first, so the server's answer is the latest one
      const res = await api("GET", `/api/book?path=${encodeURIComponent(name)}`);
      const data = await res.arrayBuffer();
      const position = decodeURIComponent(res.headers.get("X-Book-Position") || "") || null;
      const reflowPosition = decodeURIComponent(res.headers.get("X-Book-Reflow-Position") || "") || null;
      payload = { path: name, name, data, position, reflowPosition };
      idb("books", "readwrite", (s) => s.put({ data, savedAt: Date.now() }, name)).catch(() => {});
    } catch (err) {
      if (err.message === "login") return;
      if (!isNetworkError(err)) return emit("book:error", `Не вдалося відкрити книжку: ${err.message}`);
      // No network: the copy kept on this device, at the position last saved here.
      const saved = await idb("books", "readonly", (s) => s.get(name)).catch(() => null);
      if (!saved) return emit("book:error", "Немає з'єднання, а цієї книжки ще немає на пристрої. Книжка зберігається на пристрій, коли її відкривають онлайн.");
      const positions = (await localSettings())?.positions || {};
      payload = { path: name, name, data: saved.data, position: positions[name] || null, reflowPosition: positions[`${name}#reflow`] || null };
    }
    patchLocalSettings({ lastBook: name });
    emit("book:open", payload);
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

  // The library's "Додати книжку…": several files at once, uploaded one after another, no opening.
  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".epub,.pdf,application/epub+zip,application/pdf";
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  async function uploadAll(files) {
    const notice = (text, busy) => typeof showNotice === "function" && showNotice(text, busy);
    const skipped = files.filter((f) => !/\.(epub|pdf)$/i.test(f.name)).map((f) => f.name);
    const books = files.filter((f) => /\.(epub|pdf)$/i.test(f.name));
    const failed = [];
    for (const [i, file] of books.entries()) {
      notice(`Завантажую «${file.name}»${books.length > 1 ? ` (${i + 1} з ${books.length})` : ""}…`, true);
      try {
        await api("PUT", `/api/books/${encodeURIComponent(file.name)}`, file);
      } catch (err) {
        if (err.message === "login") return false;
        failed.push(`${file.name}: ${err.message}`);
      }
    }
    const added = books.length - failed.length;
    const parts = [
      added ? `Додано ${added === 1 ? "книжку" : `книжок: ${added}`}.` : "",
      failed.length ? `Не вдалося: ${failed.join("; ")}.` : "",
      skipped.length ? `Пропущено (підтримуються лише EPUB і PDF): ${skipped.join(", ")}.` : "",
    ].filter(Boolean);
    if (parts.length) notice(parts.join(" "), false);
    return added > 0;
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
      const key = `${bookPath}#reflow@${version}`;
      try {
        const res = await api("GET", `/api/reflow?path=${encodeURIComponent(bookPath)}&version=${encodeURIComponent(version)}`);
        if (res.status === 204) return null;
        const data = await res.arrayBuffer();
        idb("books", "readwrite", (s) => s.put({ data, savedAt: Date.now() }, key)).catch(() => {});
        return data;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        return (await idb("books", "readonly", (s) => s.get(key)).catch(() => null))?.data || null;
      }
    },
    reflowPut: (bookPath, version, data) => {
      idb("books", "readwrite", (s) => s.put({ data, savedAt: Date.now() }, `${bookPath}#reflow@${version}`)).catch(() => {});
      return api("PUT", `/api/reflow?path=${encodeURIComponent(bookPath)}&version=${encodeURIComponent(version)}`, new Blob([data])).catch(() => {});
    },
    libraryList: async () => {
      const onDevice = new Set((await idb("books", "readonly", (s) => s.getAllKeys()).catch(() => [])) || []);
      try {
        await sync();
        const lib = await (await api("GET", "/api/library")).json();
        kvSet("library", lib);
        return { ...lib, books: lib.books.map((b) => ({ ...b, onDevice: onDevice.has(b.path) })) };
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        const lib = await kvGet("library");
        if (!lib) throw new Error("Немає з'єднання, а бібліотека ще не збережена на пристрої.");
        // Offline the books kept here open; the others are shown, but greyed out.
        const s = (await localSettings()) || {};
        return {
          ...lib,
          lastBook: s.lastBook || lib.lastBook,
          books: lib.books.map((b) => ({ ...b, onDevice: onDevice.has(b.path), unavailable: !onDevice.has(b.path), started: b.started || !!s.positions?.[b.path] || !!s.positions?.[`${b.path}#reflow`] })),
        };
      }
    },
    libraryAddFolder: async () => {
      const files = await pickFiles();
      return files.length ? uploadAll(files) : false;
    },
    libraryRemoveFolder: async () => {},
    // Managing the shared library (family only; the server refuses guests).
    libraryDelete: (name) => api("DELETE", `/api/books/${encodeURIComponent(name)}`).then((r) => r.json()),
    libraryUpdateBook: (name, patch) => api("PATCH", `/api/books/${encodeURIComponent(name)}`, patch).then((r) => r.json()),
    getSettings: async () => {
      let settings;
      try {
        await sync();
        settings = await (await api("GET", "/api/settings")).json();
        cachedSettings = settings;
        kvSet("settings", settings);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        settings = await localSettings();
        if (!settings) throw new Error("Немає з'єднання з сервером, а на цьому пристрої ще нічого не збережено.");
      }
      // Electron reopens the last book after the window loads; here the bridge does it.
      if (!firstLoadDone) {
        firstLoadDone = true;
        if (settings.guest) enterGuestMode(settings);
        // Only once the page is fully laid out: opened during the initial load, epub.js measured
        // the reading area before it had a size and rendered a 0x0 chapter (white screen in the
        // iPhone app, where the first load is slower than in Safari).
        if (settings.lastBook) afterLoad(() => openServerBook(settings.lastBook));
      }
      return settings;
    },
    setSettings: async (patch) => {
      try {
        await sync();
        const settings = await (await api("PATCH", "/api/settings", patch)).json();
        cachedSettings = settings;
        kvSet("settings", settings);
        return settings;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        const { apiKey, ...rest } = patch; // a key is never kept on the device
        await enqueue({ type: "settings", patch: rest });
        return patchLocalSettings(rest);
      }
    },
    notesList: async (bookPath) => {
      try {
        await sync();
        const { notes } = await (await api("GET", `/api/notes?path=${encodeURIComponent(bookPath)}`)).json();
        kvSet(`notes:${bookPath}`, notes);
        return notes;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        return (await kvGet(`notes:${bookPath}`)) || [];
      }
    },
    notesAdd: async (bookPath, note) => {
      try {
        await sync();
        const { note: saved } = await (await api("POST", "/api/notes", { ...note, path: bookPath })).json();
        await cacheNotes(bookPath, (list) => (list.some((n) => n.id === saved.id) ? list : [...list, saved]));
        return saved;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        const list = (await kvGet(`notes:${bookPath}`)) || [];
        const existing = list.find((n) => n.cfi === note.cfi);
        if (existing) return existing;
        const local = { ...note, id: `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, posKey: note.posKey || bookPath, comment: "", createdAt: Date.now() };
        await kvSet(`notes:${bookPath}`, [...list, local]);
        await enqueue({ type: "noteAdd", path: bookPath, note: local });
        return local;
      }
    },
    notesUpdate: async (bookPath, id, patch) => {
      id = serverNoteId(id);
      await cacheNotes(bookPath, (list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      try {
        await sync();
        return await api("PATCH", `/api/notes/${encodeURIComponent(id)}?path=${encodeURIComponent(bookPath)}`, patch);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        if (id.startsWith("local-")) {
          // Not on the server yet: the comment travels with the note itself.
          const [keys, items] = await Promise.all([idb("queue", "readonly", (s) => s.getAllKeys()), idb("queue", "readonly", (s) => s.getAll())]);
          const i = (items || []).findIndex((it) => it.note?.id === id);
          if (i >= 0) return idb("queue", "readwrite", (s) => s.put({ ...items[i], note: { ...items[i].note, ...patch } }, keys[i]));
        }
        return enqueue({ type: "noteUpdate", path: bookPath, id, patch });
      }
    },
    notesDelete: async (bookPath, id) => {
      id = serverNoteId(id);
      await cacheNotes(bookPath, (list) => list.filter((n) => n.id !== id));
      if (id.startsWith("local-")) return unqueueNote(id);
      try {
        await sync();
        return await api("DELETE", `/api/notes/${encodeURIComponent(id)}?path=${encodeURIComponent(bookPath)}`);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        return enqueue({ type: "noteDelete", path: bookPath, id });
      }
    },
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
        else if (err.message !== "login") send({ type: "error", message: isNetworkError(err) ? "Немає з'єднання з інтернетом. Книжку можна читати далі, а пояснення з'являться, коли мережа повернеться." : err.message });
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

  // Demo: one book, no uploads, a daily cap on explanations; "Вийти" leads back to the login page.
  function enterGuestMode(settings) {
    document.body.classList.add("guest");
    const logout = document.getElementById("btn-logout");
    if (logout) (logout.textContent = "Вийти з демо"), (logout.title = "Повернутися на сторінку входу");
    const { limit = 0, used = 0 } = settings.guestLimit || {};
    const left = Math.max(0, limit - used);
    setTimeout(() => {
      if (typeof showNotice !== "function") return;
      showNotice(
        left
          ? `Демо-режим: одна книжка і до ${limit} пояснень на день (залишилось ${left}). Виділіть слово чи речення, щоб побачити, як це працює.`
          : "Демо-режим: денний ліміт пояснень уже використано. Книжку можна читати далі, а повний доступ дає вхід з паролем.",
        false,
      );
    }, 1200);
  }

  // Web-only labels.
  const libAdd = document.getElementById("lib-add");
  if (libAdd) {
    libAdd.textContent = "Додати книжки…";
    libAdd.title = "Завантажити EPUB або PDF у спільну бібліотеку (можна кілька за раз)";
  }
})();
