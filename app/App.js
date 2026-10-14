// Chytai for iPhone: a thin native shell around the web reader.
//
// The reader itself (library, EPUB rendering, explanations) is the same code the browser gets
// from https://chytai.fly.dev, so every merge to main reaches the app through the usual Fly
// deploy. This shell only adds what Safari cannot: an icon on the home screen without Safari
// chrome, the login cookie that survives, and (later) the share sheet for EPUB files.
// Changes to the shell itself ship over the air with EAS Update, without an App Store review.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { WebView } from 'react-native-webview';

export const READER_URL = 'https://chytai.fly.dev';
const READER_HOST = new URL(READER_URL).host;

// The reader's own background colours (style.css), so the native area behind the page matches
// while it loads and the splash screen does not flash white on the dark theme.
const BG = '#ffffff';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Runs inside the page before its scripts: an uncaught error or rejected promise is sent to the
// shell, which shows it in a banner, since there is no console to read on a phone.
const ERROR_REPORTER = `
  (function () {
    var send = function (text) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', text: text })); } catch (e) {}
    };
    window.addEventListener('error', function (e) {
      send((e.message || 'error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason; send('unhandled: ' + (r && r.message ? r.message : String(r)));
    });
  })();
  true;
`;

export default function App() {
  const webview = useRef(null);
  const [failed, setFailed] = useState(null);
  const [ready, setReady] = useState(false);
  const [pageError, setPageError] = useState(null);
  const [progress, setProgress] = useState(1); // 0..1 while a page loads, 1 when done

  useEffect(() => {
    if (ready || failed) SplashScreen.hideAsync().catch(() => {});
  }, [ready, failed]);

  // Links that leave the reader (a publisher's site in a footnote, a mailto) open in Safari;
  // everything on chytai.fly.dev stays inside the app.
  const onShouldStartLoadWithRequest = useCallback((request) => {
    let host = '';
    try { host = new URL(request.url).host; } catch { return true; }
    if (host === READER_HOST || request.url.startsWith('about:') || request.url.startsWith('blob:')) return true;
    Linking.openURL(request.url).catch(() => {});
    return false;
  }, []);

  const reload = useCallback(() => {
    setFailed(null);
    setReady(false);
    webview.current?.reload();
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <WebView
        ref={webview}
        source={{ uri: READER_URL }}
        style={styles.web}
        // The page extends under the status bar and the home indicator; the reader's CSS already
        // uses env(safe-area-inset-*) for its toolbar and margins, exactly as in Safari.
        contentInsetAdjustmentBehavior="never"
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        // No sharedCookiesEnabled: with it, the login cookie set on the POST /login redirect reaches
        // page navigations but not the page's own fetch() calls, so /api answers 401, the page sends
        // itself back to /login, which redirects to / again, and the first build showed a white
        // screen. WKWebView's own persistent store keeps the cookie across launches by itself.
        // Lets Safari on a Mac (Develop menu) inspect the page inside the installed app.
        webviewDebuggingEnabled
        allowsLinkPreview={false}
        pullToRefreshEnabled={false}
        bounces={false}
        textInteractionEnabled
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        injectedJavaScriptBeforeContentLoaded={ERROR_REPORTER}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'error') setPageError(String(msg.text).slice(0, 400));
          } catch { /* not ours */ }
        }}
        onLoadStart={() => setProgress(0.05)}
        onLoadProgress={(e) => setProgress(e.nativeEvent.progress)}
        onLoadEnd={() => { setReady(true); setProgress(1); }}
        onError={(e) => setFailed(e.nativeEvent.description || 'Не вдалося завантажити')}
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) setFailed(`Сервер відповів ${e.nativeEvent.statusCode}`); }}
      />
      {failed ? (
        <View style={styles.overlay}>
          <Text style={styles.title}>Chytai зараз недоступний</Text>
          <Text style={styles.detail}>{failed}</Text>
          <Pressable onPress={reload} style={styles.button}>
            <Text style={styles.buttonText}>Спробувати ще раз</Text>
          </Pressable>
        </View>
      ) : !ready ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator />
        </View>
      ) : null}
      {progress < 1 ? (
        <View style={styles.progressTrack} pointerEvents="none">
          <View style={[styles.progressBar, { width: `${Math.max(5, Math.round(progress * 100))}%` }]} />
        </View>
      ) : null}
      {pageError ? (
        <Pressable onPress={() => setPageError(null)} style={styles.banner}>
          <Text style={styles.bannerText}>Помилка сторінки: {pageError}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  web: { flex: 1, backgroundColor: BG },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 8, color: '#222' },
  detail: { fontSize: 15, color: '#666', textAlign: 'center', marginBottom: 24 },
  button: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, backgroundColor: '#222' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '500' },
  // A thin bar under the status bar while a page or a login redirect loads, so a slow network
  // never looks like a frozen app.
  progressTrack: { position: 'absolute', top: 54, left: 0, right: 0, height: 3, backgroundColor: 'transparent' },
  progressBar: { height: 3, backgroundColor: '#3b82f6', borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  banner: {
    position: 'absolute', left: 12, right: 12, bottom: 40,
    padding: 12, borderRadius: 10, backgroundColor: '#b3261e',
  },
  bannerText: { color: '#fff', fontSize: 13 },
});
