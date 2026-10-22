const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { explain } = require("./ai");
const { CONVERTIBLE, needsConversion, toEpub } = require("./convert");
const library = require("./library");

loadDotEnv(path.join(__dirname, "..", ".env"));

// Minimal .env loader so a key can live next to the project instead of in settings.
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env, that's fine */
  }
}

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
  model: "claude-opus-5-5",
  quickModel: "claude-sonnet-5-5", // the first short note; «Детальніше» and questions use `model`
  language: "українська",
  autoExplain: true,
  pageTaps: false, // phone only: page turns instead of continuous scrolling
  font: "literata",
  margins: "normal", // narrow | normal | wide
  pdfMode: "reflow", // "reflow" (як книжка) or "original"
  fontSizes: {}, // book path -> font size in %, only for books where it was changed
  theme: "auto",
  explainStyle: "default", // default | adhd | brief | simple | custom
  customStyle: "", // the reader's own instructions for "custom"
  lastBook: null,
  libraryFolders: null, // null = default folders (iCloud Backups/Downloads)
  positions: {}, // book path -> CFI
};

let settings = loadSettings();
let mainWindow = null;
let pendingOpenPath = null;
const activeStreams = new Map();

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// The API key is encrypted with the macOS Keychain via safeStorage when available.
// A key saved in settings wins over ANTHROPIC_API_KEY from the environment.
function getApiKey() {
  if (!settings.apiKeyEnc) return process.env.ANTHROPIC_API_KEY || null;
  try {
    const buf = Buffer.from(settings.apiKeyEnc, "base64");
    return settings.apiKeyPlain ? buf.toString("utf8") : safeStorage.decryptString(buf);
  } catch {
    return process.env.ANTHROPIC_API_KEY || null;
  }
}

function setApiKey(key) {
  if (!key) {
    delete settings.apiKeyEnc;
    delete settings.apiKeyPlain;
  } else if (safeStorage.isEncryptionAvailable()) {
    settings.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
    delete settings.apiKeyPlain;
  } else {
    settings.apiKeyEnc = Buffer.from(key, "utf8").toString("base64");
    settings.apiKeyPlain = true;
  }
  saveSettings();
}

function publicSettings() {
  const { apiKeyEnc, apiKeyPlain, ...rest } = settings;
  return { ...rest, hasApiKey: !!getApiKey(), apiKeyFromEnv: !settings.apiKeyEnc && !!process.env.ANTHROPIC_API_KEY };
}

// Positions and "last book" are keyed by the original file, even when we read a converted EPUB.
function readBook(filePath, epubPath = filePath) {
  const data = fs.readFileSync(epubPath);
  settings.lastBook = filePath;
  (settings.opened ??= {})[filePath] = Date.now();
  saveSettings();
  app.addRecentDocument(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    position: settings.positions[filePath] || null,
    reflowPosition: settings.positions[`${filePath}#reflow`] || null,
  };
}

async function sendOpenBook(filePath) {
  if (!mainWindow) return;
  const send = (channel, payload) => !mainWindow.isDestroyed() && mainWindow.webContents.send(channel, payload);
  try {
    let epubPath = filePath;
    if (needsConversion(filePath)) {
      send("book:converting", path.basename(filePath));
      epubPath = await toEpub(filePath, path.join(app.getPath("userData"), "converted"));
    }
    send("book:open", readBook(filePath, epubPath));
  } catch (err) {
    send("book:error", String(err.message || err));
  }
}

async function chooseBook() {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Книжки", extensions: ["epub", "pdf", ...CONVERTIBLE] },
      { name: "EPUB", extensions: ["epub"] },
    ],
  });
  if (!res.canceled && res.filePaths[0]) sendOpenBook(res.filePaths[0]);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Файл",
      submenu: [
        { label: "Відкрити книжку…", accelerator: "CmdOrCtrl+O", click: chooseBook },
        { label: "Бібліотека", accelerator: "CmdOrCtrl+L", click: () => mainWindow?.webContents.send("ui:library") },
        { role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Правка",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Знайти в книжці…", accelerator: "CmdOrCtrl+F", click: () => mainWindow?.webContents.send("ui:find", "open") },
        { label: "Наступний збіг", accelerator: "CmdOrCtrl+G", click: () => mainWindow?.webContents.send("ui:find", "next") },
        { label: "Попередній збіг", accelerator: "Shift+CmdOrCtrl+G", click: () => mainWindow?.webContents.send("ui:find", "prev") },
      ],
    },
    {
      label: "Вигляд",
      submenu: [
        { label: "Налаштування…", accelerator: "CmdOrCtrl+,", click: () => mainWindow?.webContents.send("ui:settings") },
        { label: "Панель пояснень", accelerator: "CmdOrCtrl+E", click: () => mainWindow?.webContents.send("ui:toggle-panel") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    title: "Chytai",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The page asks for icon.png next to index.html (the server serves it from build/); here it lives in build/ too.
  mainWindow.webContents.session.webRequest.onBeforeRequest({ urls: ["file://*/*/renderer/icon.png"] }, (_d, cb) =>
    cb({ redirectURL: `file://${ICON}` }),
  );
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Links inside books or explanations open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const toOpen = pendingOpenPath || (settings.lastBook && fs.existsSync(settings.lastBook) ? settings.lastBook : null);
    pendingOpenPath = null;
    if (toOpen) sendOpenBook(toOpen);
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

// macOS: double-click on an .epub or drag onto the Dock icon.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.webContents.isLoading()) sendOpenBook(filePath);
  else pendingOpenPath = filePath;
});

// In `npm start` the Dock shows Electron's icon unless we set ours; packaged builds use build/icon.png.
const ICON = path.join(__dirname, "..", "build", "icon.png");

app.whenReady().then(() => {
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("book:choose", chooseBook);
ipcMain.handle("book:open-path", (_e, filePath) => sendOpenBook(filePath));

// ---------- Library ----------

const libraryFolders = () => settings.libraryFolders || library.defaultFolders();

ipcMain.handle("library:list", async () => {
  const folders = libraryFolders();
  const books = await library.scan(folders, path.join(app.getPath("userData"), "library-cache.json"));
  for (const b of books) {
    b.started = !!(settings.positions[b.path] || settings.positions[`${b.path}#reflow`]);
    b.openedAt = settings.opened?.[b.path] || 0;
  }
  return { folders, books, lastBook: settings.lastBook };
});

ipcMain.handle("library:add-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], message: "Папка з книжками" });
  if (res.canceled || !res.filePaths[0]) return false;
  settings.libraryFolders = [...new Set([...libraryFolders(), res.filePaths[0]])];
  saveSettings();
  return true;
});

ipcMain.handle("library:remove-folder", (_e, folder) => {
  settings.libraryFolders = libraryFolders().filter((f) => f !== folder);
  saveSettings();
});

ipcMain.handle("book:save-position", (_e, bookPath, cfi) => {
  settings.positions[bookPath] = cfi;
  (settings.opened ??= {})[bookPath.replace(/#reflow$/, "")] = Date.now();
  saveSettings();
});

// Cache for PDFs converted to EPUB in the renderer ("як книжка" mode).
function reflowCachePath(bookPath, version) {
  const stat = fs.statSync(bookPath);
  const key = require("crypto").createHash("sha1").update(`${bookPath}:${stat.size}:${stat.mtimeMs}:v${version}`).digest("hex").slice(0, 16);
  return path.join(app.getPath("userData"), "converted", `${key}-reflow.epub`);
}

ipcMain.handle("reflow:get", (_e, bookPath, version) => {
  try {
    const data = fs.readFileSync(reflowCachePath(bookPath, version));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle("reflow:put", (_e, bookPath, version, data) => {
  const file = reflowCachePath(bookPath, version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data));
});

ipcMain.handle("settings:get", () => publicSettings());

ipcMain.handle("settings:set", (_e, patch) => {
  const { apiKey, ...rest } = patch || {};
  if (apiKey !== undefined) setApiKey(apiKey.trim());
  settings = { ...settings, ...rest };
  saveSettings();
  return publicSettings();
});

// Streams an explanation. Events go back to the renderer as ai:event with the request id.
ipcMain.handle("ai:explain", async (event, id, request) => {
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send("ai:event", id, payload);
  };
  const apiKey = getApiKey();
  if (!apiKey) {
    send({ type: "error", message: "Додайте ключ Claude API у налаштуваннях (⌘,)." });
    return;
  }
  const controller = new AbortController();
  activeStreams.set(id, controller);
  try {
    const result = await explain({
      apiKey,
      model: request.quick && !request.messages ? settings.quickModel : settings.model,
      language: settings.language,
      style: settings.explainStyle,
      customStyle: settings.customStyle,
      request,
      signal: controller.signal,
      onText: (text) => send({ type: "text", text }),
    });
    send({ type: "done", ...result });
  } catch (err) {
    if (controller.signal.aborted) send({ type: "aborted" });
    else send({ type: "error", message: describeError(err) });
  } finally {
    activeStreams.delete(id);
  }
});

ipcMain.handle("ai:abort", (_e, id) => activeStreams.get(id)?.abort());

function describeError(err) {
  const status = err?.status;
  if (status === 401) return "Ключ API недійсний. Перевірте його в налаштуваннях.";
  if (status === 429) return "Перевищено ліміт запитів. Спробуйте трохи згодом.";
  if (status === 529 || status >= 500) return "Сервіс Claude тимчасово перевантажений. Спробуйте ще раз.";
  if (err?.name === "APIConnectionError") return "Немає з'єднання з Claude API.";
  return err?.message || String(err);
}
