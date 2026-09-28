import { useEffect, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { editorHtml } from '../generated/editor-html';
import { loadNote, saveNote, importImage } from './storage';
import { validateContent } from '@opsidian/core';

export default function App() {
  const web = useRef<WebView>(null);
  const [error, setError] = useState('');
  const dark = useColorScheme() === 'dark';
  const backgroundColor = dark ? '#171D22' : '#FFFFFF';
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active')
        web.current?.injectJavaScript('window.OpsidianHost?.receive({event:"flush"});true;');
    });
    return () => listener.remove();
  }, []);
  async function message(event: WebViewMessageEvent) {
    let request: { id: number; session: string; method: string; content?: unknown };
    try {
      const value = JSON.parse(event.nativeEvent.data);
      if (
        !value ||
        !Number.isSafeInteger(value.id) ||
        typeof value.session !== 'string' ||
        value.session.length > 100 ||
        !['load', 'save', 'image'].includes(value.method)
      )
        throw new Error('Invalid editor request');
      request = value;
    } catch {
      setError('An invalid editor message was rejected.');
      return;
    }
    let result: unknown, failure: string | undefined;
    try {
      if (request.method === 'load') result = await loadNote();
      if (request.method === 'save') {
        validateContent(request.content);
        await saveNote(request.content);
      }
      if (request.method === 'image') result = await importImage();
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
    const json = JSON.stringify({
      id: request.id,
      session: request.session,
      result,
      error: failure,
    })
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    web.current?.injectJavaScript(`window.OpsidianHost?.receive(${json});true;`);
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.fill, { backgroundColor }]}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        {error ? (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              onPress={() => {
                setError('');
                web.current?.reload();
              }}
            >
              <Text style={styles.reload}>Reload saved note</Text>
            </Pressable>
          </View>
        ) : null}
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <WebView
            ref={web}
            source={{ html: editorHtml, baseUrl: 'https://opsidian.local/' }}
            style={[styles.fill, { backgroundColor }]}
            originWhitelist={['https://opsidian.local']}
            onMessage={(event) => void message(event)}
            javaScriptEnabled
            domStorageEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            setSupportMultipleWindows={false}
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView={true}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            scrollEnabled={false}
            onShouldStartLoadWithRequest={(request) =>
              request.url === 'about:blank' || request.url === 'https://opsidian.local/'
            }
            onContentProcessDidTerminate={() =>
              setError('The editor was stopped by iOS. Reload to restore the last confirmed save.')
            }
            onError={(event) => setError(event.nativeEvent.description)}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  fill: { flex: 1 },
  error: { padding: 16, backgroundColor: '#382a2a' },
  errorText: { color: '#f1d2cf', lineHeight: 21 },
  reload: { color: '#a9c9e3', paddingTop: 12 },
});
