// Chytai for Mac (Max, 2026-11-02): a window over the web reader at app.chytai.org.ua, so the Mac has the same
// account, books, notes and design as the phone, and every deploy reaches it. Sign-in happens inside the
// window (the reader and chytai.org.ua share it); every other link opens in the browser.
const { app, BrowserWindow, Menu, shell, session } = require("electron");

// CHYTAI_URL points the window at a local reader for trying the app out.
const HOME = process.env.CHYTAI_URL || "https://app.chytai.org.ua/";
const READER_HOST = new URL(HOME).host;
const OWN = new Set(["app.chytai.org.ua", "chytai.org.ua", READER_HOST]);
const own = (url) => {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.host === READER_HOST) && (OWN.has(u.hostname) || OWN.has(u.host));
  } catch {
    return false;
  }
};
// The reader's page and the site's sign-in stay here; a book page, the Club or a shop opens in the browser.
const inWindow = (url) => {
  if (!own(url)) return false;
  const u = new URL(url);
  return u.hostname === "app.chytai.org.ua" || u.host === READER_HOST || /^\/(reader-login|login|auth|signin|sign-in|code)/.test(u.pathname);
};

// Room for the traffic lights, and the top of the panel and of the reader's toolbar move the window.
const MAC_CSS = `
  html.mac-app #r-panel { padding-top: 52px !important; }
  html.mac-app #r-panel::before { content: ""; position: fixed; top: 0; left: 0; width: 260px; height: 40px; -webkit-app-region: drag; }
  html.mac-app #toolbar { padding-left: 84px !important; -webkit-app-region: drag; }
  html.mac-app #toolbar button, html.mac-app #toolbar input, html.mac-app #toolbar a, html.mac-app #toolbar select { -webkit-app-region: no-drag; }
  html.mac-app #shell-main::before { content: ""; position: fixed; top: 0; left: 260px; right: 0; height: 28px; -webkit-app-region: drag; z-index: 5; }
`;

let win = null;
function open() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 780,
    minHeight: 560,
    title: "Chytai",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f7f4ee",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(MAC_CSS);
    win.webContents.executeJavaScript('document.documentElement.classList.add("mac-app")').catch(() => {});
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inWindow(url)) win.loadURL(url);
    else if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (inWindow(url) || own(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
  });
  // No connection and nothing kept yet: say so instead of a blank window.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3) return;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f4ee;color:#1b1a17;font:16px -apple-system,sans-serif;-webkit-app-region:drag"><div style="text-align:center"><p style="font:600 26px Georgia,serif;margin:0 0 10px">Chytai</p><p>Немає з'єднання з Читалкою.</p><p><a href="${HOME}" style="color:#9a6418;-webkit-app-region:no-drag">Спробувати ще раз</a></p></div>`)}`);
  });
  win.on("closed", () => (win = null));
  win.loadURL(HOME);
}

function menu() {
  const name = app.name;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [{ role: "about", label: `Про ${name}` }, { type: "separator" }, { role: "hide", label: `Сховати ${name}` }, { role: "hideOthers", label: "Сховати інші" }, { role: "unhide", label: "Показати всі" }, { type: "separator" }, { role: "quit", label: `Вийти з ${name}` }] },
    { label: "Редагування", submenu: [{ role: "undo", label: "Скасувати" }, { role: "redo", label: "Повторити" }, { type: "separator" }, { role: "cut", label: "Вирізати" }, { role: "copy", label: "Копіювати" }, { role: "paste", label: "Вставити" }, { role: "selectAll", label: "Виділити все" }] },
    { label: "Вигляд", submenu: [{ role: "reload", label: "Оновити" }, { type: "separator" }, { role: "resetZoom", label: "Справжній розмір" }, { role: "zoomIn", label: "Збільшити" }, { role: "zoomOut", label: "Зменшити" }, { type: "separator" }, { role: "togglefullscreen", label: "На весь екран" }] },
    { label: "Вікно", role: "windowMenu", submenu: [{ role: "minimize", label: "Згорнути" }, { role: "zoom", label: "Масштабувати" }, { role: "close", label: "Закрити" }] },
    { label: "Допомога", role: "help", submenu: [{ label: "Клуб Chytai", click: () => shell.openExternal("https://chytai.org.ua/club") }, { label: "chytai.org.ua", click: () => shell.openExternal("https://chytai.org.ua") }] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => win && (win.isMinimized() && win.restore(), win.focus()));
app.whenReady().then(() => {
  // The site tells the Mac app apart from Safari by this.
  session.defaultSession.setUserAgent(`${session.defaultSession.getUserAgent().replace(/\s*Electron\/\S+/, "").replace(/\s*chytai-mac\/\S+/, "")} ChytaiMac/${app.getVersion()}`);
  menu();
  open();
});
app.on("activate", () => !win && open());
app.on("window-all-closed", () => app.quit());
