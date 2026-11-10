// Chytai for Mac (Max, 2026-11-02; Swift since 2026-11-10 «величезний dmg для браузер-обгортки виглядає позорно»):
// a window over the web reader at app.chytai.org.ua, so the Mac has the same account, books, notes and design as
// the phone, and every deploy reaches it. WKWebView is the system's Safari engine, so the app is a few hundred KB.
// Sign-in happens inside the window (the reader and chytai.org.ua share it); Google refuses sign-in inside an app,
// so «Увійти через Google» opens in the browser and comes back by chytai://auth?ticket=… (web/server.js
// /reader-login?to=mac). Every other link opens in the browser.
// Build: mac/build.sh. Try against a local reader: CHYTAI_URL=http://localhost:8080 build/Chytai.app/Contents/MacOS/Chytai
import Cocoa
import WebKit

let VERSION = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2"
let HOME = URL(string: ProcessInfo.processInfo.environment["CHYTAI_URL"] ?? UserDefaults.standard.string(forKey: "url") ?? "https://app.chytai.org.ua/")!
let PAPER = NSColor(srgbRed: 0xf7 / 255, green: 0xf4 / 255, blue: 0xee / 255, alpha: 1)

func hostPort(_ u: URL) -> String { u.port.map { "\(u.host ?? ""):\($0)" } ?? (u.host ?? "") }
let READER = hostPort(HOME)
let ORIGIN = "\(HOME.scheme ?? "https")://\(READER)"
let OWN: Set<String> = ["app.chytai.org.ua", "chytai.org.ua", READER]

func own(_ u: URL) -> Bool {
  (u.scheme == "https" || hostPort(u) == READER) && (OWN.contains(u.host ?? "") || OWN.contains(hostPort(u)))
}
func isGoogle(_ u: URL) -> Bool { own(u) && u.path.hasPrefix("/login/google") }
// The reader's page and the site's sign-in stay here; a book page, the Club or a shop opens in the browser.
func inWindow(_ u: URL) -> Bool {
  guard own(u), !isGoogle(u) else { return false }
  return u.host == "app.chytai.org.ua" || hostPort(u) == READER
    || u.path.range(of: "^/(reader-login|login|auth|signin|sign-in|code)", options: .regularExpression) != nil
}
func openOutside(_ u: URL) {
  if ["http", "https", "mailto"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
}
// The site's Google sign-in, in the browser, ending at /reader-login?to=mac, which hands the ticket back to us.
func googleInBrowser(_ u: URL) {
  guard var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return }
  let next = "/reader-login?back=\(ORIGIN)&to=mac".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
  c.percentEncodedQueryItems = (c.percentEncodedQueryItems ?? []).filter { $0.name != "next" } + [URLQueryItem(name: "next", value: next)]
  if let url = c.url { NSWorkspace.shared.open(url) }
}

// The class the reader's CSS keys on (style.css: html.mac-app), room for the traffic lights, and dragging the
// window by its top: the reader's toolbars and a strip along the top edge, wherever there is no button.
let PAGE_JS = """
document.documentElement.classList.add("mac-app");
(function () {
  var post = function (m) { try { webkit.messageHandlers.chytai.postMessage(m); } catch (e) {} };
  var SKIP = "button,a,input,select,textarea,label,summary,[contenteditable],[role=button],[role=slider],[draggable=true],iframe,video,audio";
  function zone(e) {
    var t = e.target;
    if (e.button !== 0 || !(t instanceof Element) || t.closest(SKIP)) return false;
    return !!t.closest("#m-top, #toolbar") || e.clientY < 28;
  }
  addEventListener("mousedown", function (e) { if (zone(e)) post("drag"); }, true);
  addEventListener("dblclick", function (e) { if (zone(e)) post("zoom"); }, true);
  addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("style");
    s.textContent = "html.mac-app #r-panel { padding-top: 52px !important; } html.mac-app #toolbar { padding-left: 84px !important; }";
    document.head.appendChild(s);
  });
})();
"""

func offlinePage() -> String {
  """
  <!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f4ee;color:#1b1a17;font:16px -apple-system,sans-serif"><div style="text-align:center"><p style="font:600 26px Georgia,serif;margin:0 0 10px">Chytai</p><p>Немає з'єднання з Читалкою.</p><p><a href="\(HOME.absoluteString)" style="color:#9a6418">Спробувати ще раз</a></p></div>
  """
}

// The site tells the Mac app apart from Safari by «ChytaiMac/<version>»; the Safari part keeps fonts and the like
// served as to Safari.
func userAgentTail() -> String {
  let safari = (NSDictionary(contentsOfFile: "/Applications/Safari.app/Contents/Info.plist")?["CFBundleShortVersionString"] as? String) ?? "17.0"
  return "Version/\(safari) Safari/605.1.15 ChytaiMac/\(VERSION)"
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var lastMouseDown: NSEvent?
  var pending: URL?
  let selftest = UserDefaults.standard.bool(forKey: "selftest")

  func applicationDidFinishLaunching(_ n: Notification) {
    menu()
    open()
    NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in self?.lastMouseDown = e; return e }
    if selftest { DispatchQueue.main.asyncAfter(deadline: .now() + 60) { print("selftest: timeout"); exit(1) } }
  }

  func open() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.userContentController.addUserScript(WKUserScript(source: PAGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController.add(self, name: "chytai")
    config.applicationNameForUserAgent = userAgentTail()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    if #available(macOS 12.3, *) { config.preferences.isElementFullscreenEnabled = true }
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = false
    web.allowsMagnification = false
    web.pageZoom = CGFloat(UserDefaults.standard.object(forKey: "zoom") as? Double ?? 1)
    web.setValue(false, forKey: "drawsBackground")
    if #available(macOS 13.3, *) { web.isInspectable = true }

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    window.title = "Chytai"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 780, height: 560)
    window.backgroundColor = PAPER
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("Chytai")
    window.makeKeyAndOrderFront(nil)
    web.load(URLRequest(url: pending ?? HOME))
    pending = nil
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window?.makeKeyAndOrderFront(nil)
    return true
  }

  // Back from the browser with a sign-in ticket: chytai://auth?ticket=<32 hex>.
  func application(_ s: NSApplication, open urls: [URL]) {
    for u in urls where u.scheme == "chytai" && u.host == "auth" {
      let t = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "ticket" }?.value ?? ""
      guard t.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil, let to = URL(string: "/auth?ticket=\(t)", relativeTo: HOME)?.absoluteURL else { continue }
      if let web = web { web.load(URLRequest(url: to)); window.makeKeyAndOrderFront(nil) } else { pending = to }
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  // ---- Where links go ----

  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = a.request.url else { return decisionHandler(.allow) }
    if a.shouldPerformDownload { return decisionHandler(.download) }
    // Chapters in iframes (about:srcdoc, blob:) and the like.
    if let f = a.targetFrame, !f.isMainFrame { return decisionHandler(.allow) }
    if ["about", "data", "blob"].contains(url.scheme ?? "") { return decisionHandler(.allow) }
    if a.targetFrame == nil { route(url); return decisionHandler(.cancel) }
    if isGoogle(url) { googleInBrowser(url); return decisionHandler(.cancel) }
    if inWindow(url) || own(url) { return decisionHandler(.allow) }
    openOutside(url)
    decisionHandler(.cancel)
  }

  func route(_ url: URL) {
    if isGoogle(url) { googleInBrowser(url) } else if inWindow(url) { web.load(URLRequest(url: url)) } else { openOutside(url) }
  }

  // target=_blank and window.open: never a second window.
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = a.request.url { route(url) }
    return nil
  }

  func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let attachment = ((r.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment")
    decisionHandler(attachment || !r.canShowMIMEType ? .download : .allow)
  }

  // No connection and nothing kept yet: say so instead of a blank window.
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    let err = e as NSError
    if err.domain == NSURLErrorDomain && err.code == NSURLErrorCancelled { return }
    if err.domain == "WebKitErrorDomain" && [102, 204].contains(err.code) { return }
    w.loadHTMLString(offlinePage(), baseURL: nil)
  }

  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    guard selftest, w.url?.host == HOME.host else { return }
    let js = """
    const r = { ua: navigator.userAgent, mac: document.documentElement.classList.contains("mac-app"), google: !!document.getElementById("g-in"), sw: "serviceWorker" in navigator };
    try { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; r.swReady = true; } catch (e) { r.swError = String(e); }
    return JSON.stringify(r);
    """
    w.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { res in
      switch res {
      case .success(let v): print("selftest: \(v)"); exit(0)
      case .failure(let e): print("selftest: error \(e)"); exit(1)
      }
    }
  }

  // ---- Files in and out ----

  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = p.allowsMultipleSelection
    panel.canChooseDirectories = p.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
  }

  func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
  func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }
  func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = name
    panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    panel.beginSheetModal(for: window) { res in
      guard res == .OK, let to = panel.url else { return completionHandler(nil) }
      try? FileManager.default.removeItem(at: to) // the panel already asked about replacing it
      completionHandler(to)
    }
  }

  // ---- The page's own questions ----

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.addButton(withTitle: "OK")
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Скасувати")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = p
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Скасувати")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  // The camera for a paper book's page and the microphone for dictation; macOS itself asks the reader once.
  @available(macOS 12.0, *)
  func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(OWN.contains(o.host) || "\(o.host):\(o.port)" == READER ? .grant : .deny)
  }

  // ---- Moving the window by the page's top ----

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    switch m.body as? String {
    case "drag":
      if let e = lastMouseDown, NSEvent.pressedMouseButtons & 1 == 1 { window.performDrag(with: e) }
    case "zoom":
      switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
      case "Minimize": window.miniaturize(nil)
      case "None": break
      default: window.zoom(nil)
      }
    default: break
    }
  }

  // ---- Menu ----

  @objc func reload() {
    if web.url == nil || web.url?.scheme == "about" { web.load(URLRequest(url: HOME)) } else { web.reload() }
  }
  @objc func zoomIn() { setZoom(web.pageZoom * 1.1) }
  @objc func zoomOut() { setZoom(web.pageZoom / 1.1) }
  @objc func zoomReset() { setZoom(1) }
  func setZoom(_ z: CGFloat) {
    web.pageZoom = min(3, max(0.5, abs(z - 1) < 0.01 ? 1 : z))
    UserDefaults.standard.set(Double(web.pageZoom), forKey: "zoom")
  }
  @objc func club() { NSWorkspace.shared.open(URL(string: "https://chytai.org.ua/club")!) }
  @objc func site() { NSWorkspace.shared.open(URL(string: "https://chytai.org.ua")!) }

  func menu() {
    let name = "Chytai"
    let main = NSMenu()
    @discardableResult func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let m = NSMenu(title: title)
      for i in items { m.addItem(i) }
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      holder.submenu = m
      main.addItem(holder)
      return m
    }
    func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      i.target = target
      return i
    }
    sub(name, [
      item("Про \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
      item("Сховати \(name)", #selector(NSApplication.hide(_:)), "h"),
      item("Сховати інші", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Показати всі", #selector(NSApplication.unhideAllApplications(_:))), .separator(),
      item("Вийти з \(name)", #selector(NSApplication.terminate(_:)), "q"),
    ])
    sub("Редагування", [
      item("Скасувати", Selector(("undo:")), "z"), item("Повторити", Selector(("redo:")), "z", [.command, .shift]), .separator(),
      item("Вирізати", #selector(NSText.cut(_:)), "x"), item("Копіювати", #selector(NSText.copy(_:)), "c"),
      item("Вставити", #selector(NSText.paste(_:)), "v"), item("Виділити все", #selector(NSText.selectAll(_:)), "a"),
    ])
    sub("Вигляд", [
      item("Оновити", #selector(reload), "r", target: self), .separator(),
      item("Справжній розмір", #selector(zoomReset), "0", target: self),
      item("Збільшити", #selector(zoomIn), "=", target: self), item("Зменшити", #selector(zoomOut), "-", target: self), .separator(),
      item("На весь екран", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let win = sub("Вікно", [
      item("Згорнути", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Масштабувати", #selector(NSWindow.performZoom(_:))),
      item("Закрити", #selector(NSWindow.performClose(_:)), "w"),
    ])
    let help = sub("Допомога", [item("Клуб Chytai", #selector(club), target: self), item("chytai.org.ua", #selector(site), target: self)])
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
    NSApp.helpMenu = help
  }
}

let delegate = App()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
