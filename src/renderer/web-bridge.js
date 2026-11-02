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
  // pdf.js reads page text with `for await (… of readableStream)`; the iPhone app's WebView can't iterate streams.
  if (window.ReadableStream && !ReadableStream.prototype[Symbol.asyncIterator]) {
    ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
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
  let offlineSayTimer = 0;
  let offlineSaid = false;
  function setOffline(value) {
    if (offline === value) return;
    offline = value;
    document.body.classList.toggle("offline", value);
    // A weak connection drops one request and passes the next: the notices flickered over the text. Say
    // «no connection» only when it lasts a few seconds, and «restored» only after that was said.
    clearTimeout(offlineSayTimer);
    if (value) offlineSayTimer = setTimeout(() => offline && ((offlineSaid = true), typeof toast === "function" && toast("Немає з'єднання: читаємо з пристрою")), 5000);
    else if (offlineSaid) (offlineSaid = false), typeof toast === "function" && toast("З'єднання відновлено");
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
    // Also apart from the settings, which the server's copy replaces on every load.
    await kvSet("here", { ...((await kvGet("here")) || {}), [path]: cfi });
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
        for (const [path, pos] of Object.entries(positions)) {
          await api("PUT", "/api/position", typeof pos === "string" ? { path, cfi: pos } : { path, ...pos });
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
        // Only while the page is hidden. «No book open» was not enough: the check runs when the app comes
        // back to the front, and a new version found a few seconds later took over while a book was still
        // loading, so its text showed for a second and the page reloaded to white (Max, 2026-11-02).
        const whenIdle = () => document.hidden && swap();
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
    let reloadWhenHidden = false;
    const reloadNow = () => (streams.size ? (reloadWhenHidden = true) : location.reload());
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // The new version takes over with a reload, never in front of the reader's eyes.
      if (hadController) document.hidden ? reloadNow() : (reloadWhenHidden = true);
      hadController = true;
    });
    document.addEventListener("visibilitychange", () => document.hidden && reloadWhenHidden && reloadNow());
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
    if (res.status === 304) return res; // the copy on the device is current (openServerBook)
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
    for (const [path, pos] of pendingPositions) {
      rememberPosition(path, pos.cfi);
      fetch("/api/position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...pos }),
        credentials: "same-origin",
        keepalive,
      })
        .then(() => setOffline(false))
        .catch(async () => {
          // No network: the position waits in IndexedDB (one per book, the latest wins) for the next sync.
          setOffline(true);
          await kvSet("positions", { ...((await kvGet("positions")) || {}), [path]: pos });
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

  // On a slow connection a tapped book gave no sign for seconds (Max, 2026-11-02): a busy notice after a
  // moment, gone once the book opens or fails.
  const OPENING = "Відкриваю книжку…";
  async function openServerBook(name) {
    const slow = setTimeout(() => typeof showNotice === "function" && showNotice(OPENING, true), 400);
    try {
      return await openServerBookNow(name);
    } finally {
      clearTimeout(slow);
      const box = document.getElementById("notice");
      if (box?.querySelector(".notice-text")?.textContent === OPENING) box.classList.add("hidden");
    }
  }
  async function openServerBookNow(name) {
    let payload;
    try {
      await sync(); // positions saved here first, so the server's answer is the latest one
      // The copy kept on the device is used when the server's file is the same (its ETag): opening a book
      // downloaded the whole file every time, seconds on a slow connection (Max, 2026-11-01).
      const saved = await idb("books", "readonly", (s) => s.get(name)).catch(() => null);
      const res = await api("GET", `/api/book?path=${encodeURIComponent(name)}`, undefined, { headers: saved?.etag ? { "If-None-Match": saved.etag } : {} });
      const position = decodeURIComponent(res.headers.get("X-Book-Position") || "") || null;
      const reflowPosition = decodeURIComponent(res.headers.get("X-Book-Reflow-Position") || "") || null;
      // A publisher's book: read chapter by chapter from the server, never kept on the device.
      if (/json/.test(res.headers.get("Content-Type") || "")) {
        const info = await res.json();
        patchLocalSettings({ lastBook: name });
        return emit("book:open", { path: name, name, url: new URL(info.base, location.href).href, preview: info.preview, position, reflowPosition });
      }
      const fresh = res.status !== 304;
      const data = fresh ? await res.arrayBuffer() : saved.data;
      // A guest's place lives in the server's memory only; after a restart (or once they sign in) the one
      // kept on this device carries on.
      const kept = position || reflowPosition ? null : (await kvGet("here").catch(() => null)) || {};
      payload = { path: name, name, data, position: position || kept?.[name] || null, reflowPosition: reflowPosition || kept?.[`${name}#reflow`] || null };
      // A copy taken now: the PDF viewer takes the buffer itself, and the database is written a moment later.
      if (fresh) {
        const copy = { data: data.slice(0), savedAt: Date.now(), etag: res.headers.get("ETag") || "" };
        idb("books", "readwrite", (s) => s.put(copy, name)).catch(() => {});
      }
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

  const BOOK_FILE = /\.(epub|pdf|mobi|azw3?|prc)$/i;
  const KINDLE_FILE = /\.(mobi|azw3?|prc)$/i;
  const ACCEPT = ".epub,.pdf,.mobi,.azw3,.azw,.prc,application/epub+zip,application/pdf,application/x-mobipocket-ebook";
  const bareName = (name) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  // The title inside an EPUB, for the notice after adding it.
  async function epubTitle(blob) {
    try {
      const zip = await JSZip.loadAsync(blob);
      const container = await zip.file("META-INF/container.xml")?.async("string");
      const opf = container && /full-path="([^"]+)"/.exec(container)?.[1];
      const xml = opf && (await zip.file(opf)?.async("string"));
      const t = xml && /<dc:title[^>]*>([^<]+)</.exec(xml)?.[1];
      return t ? new DOMParser().parseFromString(`<x>${t}</x>`, "text/xml").documentElement.textContent.trim() : "";
    } catch {
      return "";
    }
  }
  // Every book is an EPUB on the server (Max, 2026-11-01): Kindle files (MOBI, AZW3) and text PDFs become EPUB
  // here, before upload. Only a scanned PDF without text goes up as it is and opens as pages.
  async function asUpload(file, progress) {
    const epubName = file.name.replace(/\.[^.]+$/, ".epub");
    if (KINDLE_FILE.test(file.name)) {
      progress?.(`Перетворюю «${file.name}» на EPUB…`);
      const { mobiToEpub } = await import("./mobi-epub.js");
      const { data, title } = await mobiToEpub(file);
      return { name: epubName, body: data, title };
    }
    if (/\.pdf$/i.test(file.name)) {
      while (!window.PdfView) await new Promise((r) => setTimeout(r, 50));
      progress?.(`Готую текст «${file.name}»…`);
      try {
        const epub = await window.PdfView.reflow(await file.arrayBuffer(), (n, total) => progress?.(`Готую текст «${file.name}»… ${n} / ${total}`), bareName(file.name));
        const body = new Blob([epub], { type: "application/epub+zip" });
        return { name: epubName, body, title: await epubTitle(body) };
      } catch (err) {
        if (err.message !== "NO_TEXT") console.warn("PDF to EPUB failed, uploading the PDF", err);
        return { name: file.name, body: file, title: bareName(file.name) };
      }
    }
    return { name: file.name, body: file, title: (await epubTitle(file)) || bareName(file.name) };
  }

  async function uploadAndOpen(file) {
    if (!BOOK_FILE.test(file.name)) {
      return emit("book:error", "Підтримуються EPUB, PDF і MOBI (AZW3).");
    }
    if (typeof showNotice === "function") showNotice(`Завантажую «${file.name}» на сервер…`, true);
    try {
      const { name, body } = await asUpload(file, (t) => typeof showNotice === "function" && showNotice(t, true));
      if (typeof showNotice === "function") showNotice(`Завантажую «${file.name}» на сервер…`, true);
      const res = await api("PUT", `/api/books/${encodeURIComponent(name)}`, body);
      const { path } = await res.json();
      await openServerBook(path);
    } catch (err) {
      if (err.message !== "login") emit("book:error", `Не вдалося завантажити книжку: ${err.message}`);
    }
  }

  function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.onchange = () => input.files[0] && uploadAndOpen(input.files[0]);
    input.click();
  }

  // The library's "Додати книжку…": several files at once, uploaded one after another, no opening.
  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ACCEPT;
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  async function uploadAll(files) {
    const notice = (text, busy) => typeof showNotice === "function" && showNotice(text, busy);
    const skipped = files.filter((f) => !BOOK_FILE.test(f.name)).map((f) => f.name);
    const books = files.filter((f) => BOOK_FILE.test(f.name));
    const failed = [];
    const done = []; // { path, title }
    for (const [i, file] of books.entries()) {
      const of = books.length > 1 ? ` (${i + 1} з ${books.length})` : "";
      notice(`Завантажую «${file.name}»${of}…`, true);
      try {
        const { name, body, title } = await asUpload(file, (t) => notice(`${t}${of}`, true));
        const res = await api("PUT", `/api/books/${encodeURIComponent(name)}`, body);
        done.push({ path: (await res.json()).path, title });
      } catch (err) {
        if (err.message === "login") return false;
        failed.push(`${file.name}: ${err.message}`);
      }
    }
    const added = done.length;
    // The book just added by its title, with a button to open it (Max, 2026-11-01).
    const parts = [
      added === 1 ? `Додано «${done[0].title}».` : added ? `Додано книжок: ${added}.` : "",
      failed.length ? `Не вдалося: ${failed.join("; ")}.` : "",
      skipped.length ? `Пропущено (підтримуються EPUB, PDF і MOBI): ${skipped.join(", ")}.` : "",
    ].filter(Boolean);
    if (parts.length) notice(parts.join(" "), false);
    const text = document.querySelector("#notice .notice-text");
    if (added && text) {
      const open = document.createElement("button");
      open.className = "link notice-link";
      open.textContent = "Відкрити";
      open.onclick = () => {
        document.getElementById("notice").classList.add("hidden");
        openServerBook(done[done.length - 1].path);
      };
      text.append(" ", open);
    }
    return added > 0;
  }

  window.reader = {
    chooseBook: () => pickFile(),
    // Drag & drop and the file picker hand over a File; library entries hand over a name.
    pathForFile: (file) => file,
    openPath: (target) => (target instanceof File ? uploadAndOpen(target) : openServerBook(target)),
    // progress: { pct, chapter } when the reader knows them, for the home screen.
    savePosition: (bookPath, cfi, progress) => {
      pendingPositions.set(bookPath, { cfi, ...progress });
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
        return { ...lib, books: lib.books.map((b) => ({ ...b, onDevice: onDevice.has(b.path) })), free: (lib.free || []).map((b) => ({ ...b, onDevice: onDevice.has(b.path) })) };
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        const lib = await kvGet("library");
        if (!lib) throw new Error("Немає з'єднання, а бібліотека ще не збережена на пристрої.");
        // Offline the books kept here open; the others are shown, but greyed out.
        const s = (await localSettings()) || {};
        return {
          ...lib,
          lastBook: s.lastBook || lib.lastBook,
          books: lib.books.map((b) => ({ ...b, onDevice: onDevice.has(b.path), unavailable: !onDevice.has(b.path), started: b.started || (!b.aside && (!!s.positions?.[b.path] || !!s.positions?.[`${b.path}#reflow`])) })),
          free: (lib.free || []).map((b) => ({ ...b, onDevice: onDevice.has(b.path), unavailable: !onDevice.has(b.path) })),
        };
      }
    },
    libraryAddFolder: async () => {
      const files = await pickFiles();
      return files.length ? uploadAll(files) : false;
    },
    libraryRemoveFolder: async () => {},
    // Managing the shared library (family only; the server refuses guests).
    shares: (name) => api("GET", `/api/shares?path=${encodeURIComponent(name)}`).then((r) => r.json()),
    shareBook: (name, who) => api("POST", "/api/shares", { path: name, for: who }).then((r) => r.json()),
    unshare: (token) => api("DELETE", `/api/shares/${encodeURIComponent(token)}`).then((r) => r.json()),
    libraryDeleteBook: async (name) => {
      await api("DELETE", `/api/books/${encodeURIComponent(name)}`);
      idb("books", "readwrite", (s) => s.delete(name)).catch(() => {});
      const s = (await localSettings()) || {};
      if (s.lastBook === name) patchLocalSettings({ lastBook: null });
    },
    libraryTrash: () => api("GET", "/api/trash").then((r) => r.json()),
    libraryForgetBook: (name) => api("POST", "/api/trash/forget", { path: name }),
    libraryRestoreBook: (name) => api("POST", "/api/trash/restore", { path: name }).then((r) => r.json()),
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
        // Model, language, the demo book and the stats are the owner's (Max); other accounts read with his choice.
        document.body.classList.toggle("not-owner", !settings.guest && !settings.owner);
        // Only once the page is fully laid out: opened during the initial load, epub.js measured
        // the reading area before it had a size and rendered a 0x0 chapter (white screen in the
        // iPhone app, where the first load is slower than in Safari).
        // The family starts on the home screen (home.js); a guest has one book and goes straight to it.
        if (settings.guest && settings.lastBook) afterLoad(() => openServerBook(settings.lastBook));
        // «Читати» on a book's page at chytai.org.ua opens /?open=<file name> here.
        const open = !settings.guest && new URLSearchParams(location.search).get("open");
        if (open) {
          history.replaceState(null, "", "/");
          afterLoad(() => openServerBook(open));
        }
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
    // ---------- Home screen ----------
    coverUrl: (b) => (b.ext === "epub" || b.coverAt ? `/api/cover?path=${encodeURIComponent(b.path)}&v=${b.mtime || 0}-${b.coverAt || 0}` : null),
    notesAll: async () => {
      try {
        await sync();
        const { books } = await (await api("GET", "/api/notes/all")).json();
        for (const [path, list] of Object.entries(books)) kvSet(`notes:${path}`, list);
        return books;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        // Offline: the notes of every book kept on this device.
        const keys = (await idb("kv", "readonly", (s) => s.getAllKeys()).catch(() => [])) || [];
        const books = {};
        for (const key of keys.filter((k) => String(k).startsWith("notes:"))) {
          const list = await kvGet(key);
          if (list?.length) books[key.slice(6)] = list;
        }
        return books;
      }
    },
    librarySetAside: async (name) => {
      await api("POST", "/api/library/aside", { path: name });
      const s = (await localSettings()) || {};
      if (s.lastBook === name) patchLocalSettings({ lastBook: null });
    },
    clubFeed: async () => (await api("GET", "/api/club")).json(),
    // «Про книжку»: the site's short summary, kept on the device. `cachedOnly` reads the device copy alone;
    // without it the network is asked first and the device copy is the fallback (null when there is none).
    bookAbout: async (b, cachedOnly = false) => {
      const key = `about:${b.path}`;
      const kept = await kvGet(key);
      if (cachedOnly) return kept || null;
      try {
        const q = new URLSearchParams({ title: b.title, author: (b.authors || []).join(", ") });
        const data = await (await api("GET", `/api/about?${q}`)).json();
        kvSet(key, { ...data, at: Date.now() });
        return data;
      } catch {
        return kept || null;
      }
    },
    uploadFiles: (files) => uploadAll(files),
    libraryTake: (name) => api("POST", "/api/library/take", { path: name }),
    catalogFind: async (q) => (await api("GET", `/api/find?${new URLSearchParams({ q })}`)).json(),
    libraryFinished: (name, done) => api("POST", "/api/library/finished", { path: name, done }),
    librarySeen: (paths) => api("POST", "/api/library/seen", { paths }).catch(() => {}),
    wishList: async () => {
      try {
        const { wish } = await (await api("GET", "/api/wish")).json();
        kvSet("wish", wish);
        return wish;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        return (await kvGet("wish")) || [];
      }
    },
    wishAdd: async (item) => {
      const { wish } = await (await api("POST", "/api/wish", item)).json();
      kvSet("wish", wish);
      return wish;
    },
    wishRemove: async (id) => {
      const { wish } = await (await api("DELETE", `/api/wish/${encodeURIComponent(id)}`)).json();
      kvSet("wish", wish);
      return wish;
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
    if (logout) (logout.textContent = settings.share || settings.free ? "Вийти" : "Вийти з демо"), (logout.title = "Повернутися на сторінку входу");
    const { limit = 0, used = 0 } = settings.guestLimit || {};
    const left = Math.max(0, limit - used);
    setTimeout(() => {
      if (typeof showNotice !== "function") return;
      // A free book from the site, without an account.
      if (settings.free) {
        // The file is downloaded from the site's catalog; here, what an account adds (Max, 2026-10-26).
        showNotice("З акаунтом є пояснення від Claude і нотатки.", false);
        noticeLink(settings.free.signIn, "Створити акаунт");
        return;
      }
      // By a link to one book: whose it is and until when.
      if (settings.share) {
        const until = new Date(settings.share.until).toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
        // Once per link: on every visit it only got in the way of the book.
        const seen = `share-welcome:${settings.share.from}:${settings.share.until}`;
        try {
          if (localStorage.getItem(seen)) return;
          localStorage.setItem(seen, "1");
        } catch {}
        return showNotice(`${settings.share.from} дає вам почитати цю книжку. Посилання діє до ${until}, на цьому пристрої. Виділіть слово чи речення, і Claude пояснить (до ${limit} разів на день).`, false);
      }
      showNotice(
        left
          ? `Демо-режим: одна книжка і до ${limit} пояснень на день (залишилось ${left}). Виділіть слово чи речення, щоб побачити, як це працює.`
          : "Демо-режим: пояснення на сьогодні закінчились. Книжку можна читати далі.",
        false,
      );
    }, 1200);
  }

  // Web-only labels.
  const libAdd = document.getElementById("lib-add");
  if (libAdd) {
    libAdd.textContent = "Додати книжки…";
    libAdd.title = "Завантажити EPUB, PDF або MOBI (можна кілька за раз)";
  }
  // The Mac app's «Оновити» rescans folders and its «Відкрити» opens a file from the disk; on the web there are no
  // folders, and books come in through «Додати книжки…» on Головна.
  document.getElementById("lib-refresh")?.classList.add("hidden");
  document.getElementById("btn-open")?.classList.add("hidden");
})();
