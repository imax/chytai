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

export default function App() {
  const webview = useRef(null);
  const [failed, setFailed] = useState(null);
  const [ready, setReady] = useState(false);

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
        sharedCookiesEnabled
        // Keeps the WKWebView process alive in the background so the reading position and the
        // open explanation survive a switch to another app.
        allowsLinkPreview={false}
        pullToRefreshEnabled={false}
        bounces={false}
        textInteractionEnabled
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onLoadEnd={() => setReady(true)}
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
});
