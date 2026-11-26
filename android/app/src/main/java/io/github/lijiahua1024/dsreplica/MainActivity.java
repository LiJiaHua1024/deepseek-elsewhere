package io.github.lijiahua1024.dsreplica;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + ASSET_HOST + "/index.html";
    private static final String PROFILE_KEY = "profile";
    private static final int MICROPHONE = 1;
    private static final int FILE_CHOOSER = 2;
    private static final int PHOTOS = 3;
    private static final int CAMERA = 4;
    private static final int EXPORT_HISTORY = 5;
    private static final int WRITE_IMAGES = 6;
    private static final int NOTIFICATIONS = 7;
    private static final int MICROPHONE_SYSTEM_ASR = 8;
    private WebView webView;
    private FrameLayout frame;
    private ApiKeyStore keys;
    private ApiKeyStore chatConfig;
    private ApiKeyStore providerSecrets;
    private ApiKeyStore memorySyncSecret;
    private ApiKeyStore voiceSecrets;
    private final CustomChatTransport customChat = new CustomChatTransport();
    private final NativeHttpTransport nativeHttp = new NativeHttpTransport();
    private final NativeHttpStreamTransport nativeHttpStream = new NativeHttpStreamTransport();
    private final NativeEdgeTtsTransport nativeEdgeTts = new NativeEdgeTtsTransport();
    private NativeSystemSpeech nativeSystemSpeech;
    private String pendingSystemAsrLang;
    private PyodideRuntimeStore pyodideStore;
    private SharedPreferences profilePreferences;
    private ValueCallback<Uri[]> fileCallback;
    private boolean choosingPhotos;
    private boolean keyboardVisible;
    private volatile float statusInset;
    private volatile float buttonNavigationInset;
    private boolean askedForPhotos;
    private Uri capture;
    private RecentPhotos recentPhotos;
    private FileExport historyExport;
    private ChatStorage chatStorage;
    private final Object storageOwner = new Object();
    private ShadowStore shadow;
    private ImageSave imageSave;
    private NativeRecorder recorder;
    private AppUpdater updater;
    private boolean backPreviewEnabled;
    private volatile boolean isForeground;
    private boolean webPageReady;
    private String pendingOpenSessionId;
    private final InAppBackCallback inAppBack = new InAppBackCallback(this, this::handleBack,
        this::reportBackPreview);
    private final ExecutorService photoExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService balanceExecutor = Executors.newSingleThreadExecutor();
    private AccessibilityManager accessibility;
    private final AccessibilityManager.AccessibilityStateChangeListener accessibilityState =
        enabled -> {
            if (enabled) primeAccessibility();
        };

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        keys = new ApiKeyStore(this);
        chatConfig = new ApiKeyStore(this, "custom-chat");
        providerSecrets = new ApiKeyStore(this, "provider-secrets");
        memorySyncSecret = new ApiKeyStore(this, "memory-sync-secret");
        voiceSecrets = new ApiKeyStore(this, "voice-secrets");
        pyodideStore = new PyodideRuntimeStore(this);
        profilePreferences = getSharedPreferences("account_profile", MODE_PRIVATE);
        recentPhotos = new RecentPhotos(getContentResolver());
        historyExport = new FileExport(getContentResolver());
        chatStorage = ChatStorage.get(this);
        shadow = new ShadowStore(this);
        imageSave = new ImageSave(this);
        recorder = new NativeRecorder();
        nativeSystemSpeech = new NativeSystemSpeech(this);
        frame = new FrameLayout(this);
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        SystemBars.applyInsets(getWindow(), frame, (safe, ime, buttonNavigationBottom) -> {
            // Let WebView paint behind the navigation buttons while CSS insets the controls.
            int webBottom = ime ? 0 : buttonNavigationBottom;
            frame.setPadding(safe.left, 0, safe.right, safe.bottom - webBottom);
            float density = getResources().getDisplayMetrics().density;
            float top = safe.top / density;
            float bottom = webBottom / density;
            if (top != statusInset || bottom != buttonNavigationInset || ime != keyboardVisible) {
                statusInset = top;
                buttonNavigationInset = bottom;
                keyboardVisible = ime;
                webView.evaluateJavascript("if (document.documentElement) { const root = document.documentElement;"
                    + "root.style.setProperty('--android-status-inset', '" + top + "px');"
                    + "root.style.setProperty('--android-button-nav-inset', '" + bottom + "px');"
                    + (bottom > 0 ? "root.setAttribute('data-button-navigation', '');" : "root.removeAttribute('data-button-navigation');")
                    + (ime ? "root.setAttribute('data-keyboard', '');" : "root.removeAttribute('data-keyboard');")
                    + " }", null);
            }
        });
        setContentView(frame);
        accessibility = getSystemService(AccessibilityManager.class);
        if (accessibility != null) {
            accessibility.addAccessibilityStateChangeListener(accessibilityState);
        }
        setBars((getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES);
        WebView.setWebContentsDebuggingEnabled(
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new AppPage());
        webView.setWebChromeClient(new DeviceFeatures());
        webView.addJavascriptInterface(new DeviceBridge(), "DeepSeekAndroid");
        updater = new AppUpdater(this, status ->
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-update', {detail: "
                + status + "}))", null));
        StreamKeepAliveService.setStopListener(this::dispatchStopStream);
        handleOpenSessionIntent(getIntent());
        webView.loadUrl(HOME);
    }

    private void primeAccessibility() {
        if (webView == null) return;
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        AccessibilityNodeInfo host = webView.createAccessibilityNodeInfo();
        if (host != null) host.recycle();
    }

    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation") // Legacy back still needs to ask the WebView first.
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        webView.evaluateJavascript("window.dispatchEvent(new Event('android-back', {cancelable: true}))",
            result -> { if ("true".equals(result)) finish(); });
    }

    private void reportBackPreview(InAppBackCallback.Preview event) {
        if (!backPreviewEnabled) return;
        String detail = "null";
        if (event != null) {
            float density = getResources().getDisplayMetrics().density;
            String edge = event.edge() == null ? "null" : "'" + event.edge() + "'";
            detail = "{progress: " + event.progress() + ", edge: " + edge
                + ", touchY: " + (event.touchY() / density) + "}";
        }
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-back-preview', {detail: "
            + detail + "}))", null);
    }

    private void setBars(boolean dark) {
        SystemBars.setAppearance(getWindow(), dark);
        int color = Color.parseColor(dark ? "#151517" : "#FFFFFF");
        frame.setBackgroundColor(color);
        webView.setBackgroundColor(color);
    }

    private static boolean isBundled(Uri url) {
        return "https".equals(url.getScheme()) && ASSET_HOST.equals(url.getHost())
            && url.getPort() == -1;
    }

    private static String assetMimeType(String extension) {
        String lower = extension.toLowerCase(java.util.Locale.ROOT);
        return switch (lower) {
            case "html" -> "text/html";
            case "js" -> "text/javascript";
            case "css" -> "text/css";
            case "svg" -> "image/svg+xml";
            case "woff2" -> "font/woff2";
            case "woff" -> "font/woff";
            case "ttf" -> "font/ttf";
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "webp" -> "image/webp";
            case "json" -> "application/json";
            default -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(lower);
        };
    }

    private final class AppPage extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            webPageReady = false;
            backPreviewEnabled = false;
            inAppBack.setEnabled(false);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            webPageReady = true;
            if (pendingOpenSessionId != null) {
                String sessionId = pendingOpenSessionId;
                pendingOpenSessionId = null;
                dispatchOpenSession(sessionId);
            }
            if (accessibility != null && accessibility.isEnabled()) {
                primeAccessibility();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isBundled(request.getUrl())) {
                return !request.isForMainFrame() || !"/index.html".equals(request.getUrl().getPath());
            }
            String scheme = request.getUrl().getScheme();
            if (request.isForMainFrame() && ("https".equals(scheme) || "http".equals(scheme))) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException ignored) {
                    // The device has no browser for external links.
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!isBundled(url)) return null;
            String path = url.getPath();
            if ("GET".equals(request.getMethod()) && path != null && path.startsWith("/chat-attachment/")) {
                try {
                    return new WebResourceResponse("application/octet-stream", null, 200, "OK",
                        Maps.of("Cache-Control", "no-store", "X-Content-Type-Options", "nosniff"),
                        chatStorage.openAttachment(path.substring("/chat-attachment/".length())));
                } catch (IOException ignored) {
                    // A missing native file returns the bundled origin's 404.
                }
            }
            if ("/recording.wav".equals(path)) {
                WebResourceResponse audio = recorder.takeWav();
                if (audio != null) return audio;
            }
            if (path != null && path.matches("/(recent|thumbnail)/[0-9]+")) {
                WebResourceResponse photo = recentPhotos.open(url.getLastPathSegment(),
                    path.startsWith("/thumbnail/"));
                if (photo != null) return photo;
            }
            if (path != null && path.startsWith("/pyodide/")) {
                WebResourceResponse pyodideAsset = pyodideStore.openAsset(path);
                if (pyodideAsset != null) return pyodideAsset;
            }
            if ("/index.html".equals(path) || (path != null && path.startsWith("/static/")
                    && !path.contains("/../"))) {
                String name = path.substring(1);
                String extension = name.substring(name.lastIndexOf('.') + 1);
                String type = assetMimeType(extension);
                Map<String, String> headers = Maps.of("Content-Security-Policy",
                    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; child-src 'self'; "
                    + "style-src 'self' 'unsafe-inline'; "
                    + "img-src 'self' https: data: blob:; font-src 'self' data:; "
                    + "media-src 'self' blob:; connect-src 'self' https://api.deepseek.com; "
                    + "frame-src 'none'; base-uri 'none'; form-action 'none';");
                try {
                    return new WebResourceResponse(type == null ? "application/octet-stream" : type,
                        "UTF-8", 200, "OK", headers, getAssets().open(name));
                } catch (IOException ignored) {
                    // Unknown paths must stay inside the bundled origin.
                }
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                Maps.of(), new ByteArrayInputStream(new byte[0]));
        }
    }

    private final class DeviceFeatures extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            choosingPhotos = false;
            if (params.isCaptureEnabled()) {
                if (granted(Manifest.permission.CAMERA)) {
                    launchCamera();
                } else {
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA);
                }
                return true;
            }
            boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            String[] mimeTypes = Arrays.stream(params.getAcceptTypes())
                .map(type -> type.startsWith(".")
                    ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.substring(1)) : type)
                .filter(type -> type != null && type.contains("/"))
                .distinct().toArray(String[]::new);
            intent.setType(mimeTypes.length == 1 ? mimeTypes[0] : "*/*");
            if (mimeTypes.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
            choosingPhotos = Arrays.equals(mimeTypes, new String[]{"image/*"});
            if (Build.VERSION.SDK_INT >= 33 && choosingPhotos) {
                Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
                if (multiple) {
                    picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10);
                }
                try {
                    startActivityForResult(picker, FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException ignored) {
                    // Use the document picker on devices without the system photo picker.
                }
            }
            try {
                startActivityForResult(intent, FILE_CHOOSER);
            } catch (ActivityNotFoundException ignored) {
                fileCallback = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasRecentPhotosPermission() {
        String imagesPermission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        return granted(imagesPermission) || (Build.VERSION.SDK_INT >= 34
            && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED));
    }

    private void showRecentPhotos() {
        String imagesPermission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (!hasRecentPhotosPermission() && !askedForPhotos) {
            askedForPhotos = true;
            String[] permissions = Build.VERSION.SDK_INT >= 34
                ? new String[]{imagesPermission, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED}
                : new String[]{imagesPermission};
            requestPermissions(permissions, PHOTOS);
        } else {
            notifyRecentPhotos();
        }
    }

    private void notifyRecentPhotos() {
        photoExecutor.execute(() -> {
            String photos = recentPhotos.list();
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-photos', "
                        + "{detail: " + photos + "}))", null);
                }
            });
        });
    }

    private void launchCamera() {
        try {
            capture = CaptureProvider.create(this);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, capture)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            camera.setClipData(ClipData.newRawUri("photo", capture));
            startActivityForResult(camera, FILE_CHOOSER);
        } catch (IOException | ActivityNotFoundException ignored) {
            capture = null;
            completeFileChooser(null);
        }
    }

    private void completeFileChooser(Uri[] files) {
        if (fileCallback == null) return;
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        callback.onReceiveValue(files);
    }

    private void completePhotoChooser(Uri[] files) {
        ValueCallback<Uri[]> callback = fileCallback;
        photoExecutor.execute(() -> {
            for (int index = 0; index < files.length; index++) {
                Uri uri = files[index];
                try {
                    if (!SelectedPhoto.isHeif(getContentResolver().getType(uri))) continue;
                    Uri decoded = CaptureProvider.createPng(this);
                    try (OutputStream output = getContentResolver().openOutputStream(decoded)) {
                        if (output == null) continue;
                        SelectedPhoto.writePng(getContentResolver(), uri, output);
                    }
                    files[index] = decoded;
                } catch (IOException | RuntimeException ignored) {
                    // The original document can still be handled by normal attachment validation.
                }
            }
            runOnUiThread(() -> {
                if (!isDestroyed() && fileCallback == callback) completeFileChooser(files);
            });
        });
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == MICROPHONE) {
            startRecording();
        } else if (code == MICROPHONE_SYSTEM_ASR) {
            String lang = pendingSystemAsrLang;
            pendingSystemAsrLang = null;
            if (granted(Manifest.permission.RECORD_AUDIO)) {
                startSystemAsrInternal(lang);
            } else {
                dispatchAndroidEvent("android-system-asr", "{\"type\":\"error\",\"kind\":\"denied\"}");
            }
        } else if (code == PHOTOS) {
            notifyRecentPhotos();
        } else if (code == CAMERA && fileCallback != null) {
            if (granted(Manifest.permission.CAMERA)) {
                launchCamera();
            } else {
                completeFileChooser(null);
            }
        } else if (code == WRITE_IMAGES) {
            reportImageSavePermission(granted(Manifest.permission.WRITE_EXTERNAL_STORAGE));
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == AppUpdater.INSTALL_SOURCE_SETTINGS) {
            updater.permissionResult();
        } else if (code == EXPORT_HISTORY) {
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            reportExport(uri == null ? "cancelled" : historyExport.open(uri) ? "ready" : "error");
        } else if (code == FILE_CHOOSER && fileCallback != null) {
            Uri[] files = null;
            if (result == RESULT_OK) {
                if (capture != null) {
                    files = new Uri[]{capture};
                } else if (data != null && data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    files = new Uri[clip.getItemCount()];
                    for (int index = 0; index < files.length; index++) {
                        files[index] = clip.getItemAt(index).getUri();
                    }
                } else if (data != null && data.getData() != null) {
                    files = new Uri[]{data.getData()};
                }
            }
            capture = null;
            if (choosingPhotos && files != null) {
                completePhotoChooser(files);
            } else {
                completeFileChooser(files);
            }
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (frame != null) {
            frame.requestApplyInsets();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOpenSessionIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        isForeground = true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        updater.resume();
        if (webView != null && !isDestroyed()) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('android-resume'))", null);
        }
    }

    @Override
    protected void onPause() {
        updater.pause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        isForeground = false;
        recorder.finish(false);
        if (nativeSystemSpeech != null) {
            nativeSystemSpeech.cancelAsr();
        }
        webView.evaluateJavascript("window.dispatchEvent(new Event('android-recording-interrupted'))", null);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        StreamKeepAliveService.setStopListener(null);
        StreamKeepAliveService.stopIfRunning(this);
        customChat.close();
        nativeHttp.close();
        nativeHttpStream.close();
        nativeEdgeTts.close();
        if (nativeSystemSpeech != null) nativeSystemSpeech.destroy();
        if (pyodideStore != null) pyodideStore.close();
        inAppBack.setEnabled(false);
        if (accessibility != null) {
            accessibility.removeAccessibilityStateChangeListener(accessibilityState);
        }
        photoExecutor.shutdownNow();
        balanceExecutor.shutdownNow();
        updater.close();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        recorder.finish(false);
        historyExport.close();
        chatStorage.disconnect(storageOwner);
        imageSave.finish(false);
        frame.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }

    private void reportExport(String state) {
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-export', "
            + "{detail: '" + state + "'}))", null);
    }

    private void reportImageSavePermission(boolean granted) {
        if (isDestroyed() || webView == null) return;
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-image-save-permission', "
            + "{detail: '" + (granted ? "granted" : "denied") + "'}))", null);
    }

    private void startRecording() {
        String state = !granted(Manifest.permission.RECORD_AUDIO) ? "denied"
            : recorder.start() ? "ready" : "error";
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-recording', "
            + "{detail: '" + state + "'}))", null);
    }

    private void startSystemAsrInternal(String langTag) {
        if (nativeSystemSpeech == null) return;
        nativeSystemSpeech.startAsr(langTag, json -> dispatchAndroidEvent("android-system-asr", json));
    }

    private void dispatchAndroidEvent(String eventName, String detailJson) {
        runOnUiThread(() -> {
            if (isDestroyed() || webView == null) return;
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('" + eventName + "',{detail:" + detailJson + "}))",
                null
            );
        });
    }

    private final class DeviceBridge {
        @JavascriptInterface
        public float statusInset() { return statusInset; }

        @JavascriptInterface
        public float buttonNavigationInset() { return buttonNavigationInset; }

        @JavascriptInterface
        public float systemFontScale() { return getResources().getConfiguration().fontScale; }

        @JavascriptInterface
        public int getMusicVolume() {
            AudioManager audio = getSystemService(AudioManager.class);
            return audio == null ? -1 : audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        }

        @JavascriptInterface
        public void openAppPermissions() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null))));
        }

        @JavascriptInterface
        public String updateStatus() { return updater.status(); }

        @JavascriptInterface
        public void checkForUpdate() { runOnUiThread(() -> updater.check()); }

        @JavascriptInterface
        public void installUpdate() { runOnUiThread(() -> updater.update()); }

        @JavascriptInterface
        public void openSourcePage(String url, boolean dark, String closeLabel, String browserLabel,
                                   String loadingLabel, String errorLabel, String retryLabel) {
            Uri uri = SourceBrowserActivity.webUri(url);
            if (uri == null) return;
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, SourceBrowserActivity.class)
                .setData(uri).putExtra("dark", dark)
                .putExtra("closeLabel", closeLabel).putExtra("browserLabel", browserLabel)
                .putExtra("loadingLabel", loadingLabel).putExtra("errorLabel", errorLabel)
                .putExtra("retryLabel", retryLabel)));
        }

        @JavascriptInterface
        public String readApiKey() { return keys.read(); }

        @JavascriptInterface
        public boolean writeApiKey(String value) { return keys.write(value); }

        @JavascriptInterface
        public String readChatConfig() { return chatConfig.read(); }

        @JavascriptInterface
        public boolean writeChatConfig(String value) { return chatConfig.write(value); }

        @JavascriptInterface
        public String readProviderSecrets() { return providerSecrets.read(); }

        @JavascriptInterface
        public boolean writeProviderSecrets(String value) { return providerSecrets.write(value); }

        @JavascriptInterface
        public String readMemorySyncSecret() { return memorySyncSecret.read(); }

        @JavascriptInterface
        public boolean writeMemorySyncSecret(String value) { return memorySyncSecret.write(value); }

        @JavascriptInterface
        public String readVoiceSecrets() { return voiceSecrets.read(); }

        @JavascriptInterface
        public boolean writeVoiceSecrets(String value) { return voiceSecrets.write(value); }

        @JavascriptInterface
        public boolean beginEdgeTts(String requestId, String payload) {
            return nativeEdgeTts.synthesize(requestId, payload,
                json -> dispatchAndroidEvent("android-edge-tts", json));
        }

        @JavascriptInterface
        public void cancelEdgeTts(String requestId) {
            nativeEdgeTts.cancel(requestId);
        }

        @JavascriptInterface
        public boolean fetchEdgeVoices(String requestId) {
            return nativeEdgeTts.fetchVoices(requestId,
                json -> dispatchAndroidEvent("android-edge-voices", json));
        }

        @JavascriptInterface
        public void listSystemTtsVoices(String requestId) {
            if (nativeSystemSpeech == null) return;
            nativeSystemSpeech.listVoices(requestId,
                json -> dispatchAndroidEvent("android-system-tts-voices", json));
        }

        @JavascriptInterface
        public void speakSystemTts(String utteranceId, String text, String voiceId, float rate) {
            if (nativeSystemSpeech == null) return;
            nativeSystemSpeech.speak(utteranceId, text, voiceId, rate,
                json -> dispatchAndroidEvent("android-system-tts", json));
        }

        @JavascriptInterface
        public void stopSystemTts() {
            if (nativeSystemSpeech != null) nativeSystemSpeech.stopTts();
        }

        @JavascriptInterface
        public boolean isSystemAsrAvailable() {
            return nativeSystemSpeech != null && nativeSystemSpeech.isAsrAvailable();
        }

        @JavascriptInterface
        public void startSystemAsr(String langTag) {
            runOnUiThread(() -> {
                if (granted(Manifest.permission.RECORD_AUDIO)) {
                    startSystemAsrInternal(langTag);
                } else {
                    pendingSystemAsrLang = langTag;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_SYSTEM_ASR);
                }
            });
        }

        @JavascriptInterface
        public void stopSystemAsr() {
            if (nativeSystemSpeech != null) nativeSystemSpeech.stopAsr();
        }

        @JavascriptInterface
        public void cancelSystemAsr() {
            if (nativeSystemSpeech != null) nativeSystemSpeech.cancelAsr();
        }

        @JavascriptInterface
        public double systemAsrLevel() {
            return nativeSystemSpeech != null ? nativeSystemSpeech.getAsrLevel() : 0;
        }

        @JavascriptInterface
        public boolean beginAsrUpload(String requestId, String payloadJson) {
            byte[] wav = recorder.takeWavBytes();
            if (wav == null || wav.length == 0) {
                return false;
            }
            return nativeHttp.beginMultipartAudio(requestId, payloadJson, wav,
                json -> dispatchAndroidEvent("android-http-response", json));
        }

        @JavascriptInterface
        public String beginChatRequest(String endpoint, String format, String body) {
            return customChat.begin(chatConfig.read(), endpoint, format, body, payload ->
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-custom-chat',{detail:"
                        + payload + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelChatRequest(String id) { if (id != null) customChat.cancel(id); }

        @JavascriptInterface
        public boolean beginHttpRequest(String requestId, String payload) {
            return nativeHttp.begin(requestId, payload, json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-http-response',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelHttpRequest(String requestId) {
            if (requestId != null) nativeHttp.cancel(requestId);
        }

        @JavascriptInterface
        public boolean beginHttpStream(String streamId, String payload) {
            return nativeHttpStream.begin(streamId, payload, json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-http-stream',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelHttpStream(String streamId) {
            if (streamId != null) nativeHttpStream.cancel(streamId);
        }

        @JavascriptInterface
        public String getPyodideStatus() {
            return pyodideStore != null ? pyodideStore.getStatusJson() : "{}";
        }

        @JavascriptInterface
        public void beginPyodideDownload() {
            if (pyodideStore == null) return;
            pyodideStore.beginDownload(json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-pyodide-status',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelPyodideDownload() {
            if (pyodideStore == null) return;
            pyodideStore.cancelDownload(json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-pyodide-status',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public boolean clearPyodideCache() {
            if (pyodideStore == null) return false;
            return pyodideStore.clearCache(json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-pyodide-status',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public boolean ensurePyodideFiles(String requestId, String filesJsonArray) {
            if (pyodideStore == null) return false;
            return pyodideStore.ensureFiles(requestId, filesJsonArray, json ->
                runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-pyodide-files',{detail:"
                        + json + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelPyodideFiles(String requestId) {
            if (pyodideStore != null && requestId != null) {
                pyodideStore.cancelEnsureFiles(requestId);
            }
        }

        @JavascriptInterface
        public void requestOfficialBalance(String requestId) {
            if (requestId == null || requestId.isEmpty()) return;
            String apiKey = keys.read();
            if (apiKey == null || apiKey.isEmpty()) {
                emitBalanceResult(requestId, false, 0, "");
                return;
            }
            balanceExecutor.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL("https://api.deepseek.com/user/balance")
                        .openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(10_000);
                    connection.setReadTimeout(15_000);
                    connection.setRequestMethod("GET");
                    connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                    connection.setRequestProperty("Accept", "application/json");
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        emitBalanceResult(requestId, false, status, "");
                        return;
                    }
                    String body = "";
                    try (InputStream input = status >= 400
                            ? connection.getErrorStream()
                            : connection.getInputStream()) {
                        if (input != null) {
                            ByteArrayOutputStream output = new ByteArrayOutputStream();
                            byte[] buffer = new byte[4096];
                            int total = 0;
                            int count;
                            while (total < 65_536
                                    && (count = input.read(buffer, 0, Math.min(buffer.length, 65_536 - total))) != -1) {
                                output.write(buffer, 0, count);
                                total += count;
                            }
                            body = new String(output.toByteArray(), StandardCharsets.UTF_8);
                        }
                    }
                    emitBalanceResult(requestId, status >= 200 && status < 300, status, body);
                } catch (IOException | RuntimeException ignored) {
                    emitBalanceResult(requestId, false, 0, "");
                } finally {
                    if (connection != null) connection.disconnect();
                }
            });
        }

        @JavascriptInterface
        public String readAccountProfile() { return profilePreferences.getString(PROFILE_KEY, null); }

        @JavascriptInterface
        public boolean writeAccountProfile(String value) {
            SharedPreferences.Editor editor = profilePreferences.edit();
            if (value == null) editor.remove(PROFILE_KEY);
            else editor.putString(PROFILE_KEY, value);
            return editor.commit();
        }

        @JavascriptInterface
        public void setDarkBars(boolean dark) { runOnUiThread(() -> setBars(dark)); }

        @JavascriptInterface
        public void setHandlesBack(boolean handlesBack) {
            runOnUiThread(() -> { if (!isDestroyed()) inAppBack.setEnabled(handlesBack); });
        }

        @JavascriptInterface
        public void setBackPreviewEnabled(boolean enabled) {
            runOnUiThread(() -> { if (!isDestroyed()) backPreviewEnabled = enabled; });
        }

        @JavascriptInterface
        public void setImageViewerFullscreen(boolean fullscreen) {
            runOnUiThread(() -> SystemBars.setFullscreen(getWindow(), fullscreen));
        }

        @JavascriptInterface
        public void requestRecentPhotos() { runOnUiThread(() -> showRecentPhotos()); }

        @JavascriptInterface
        public void prefetchRecentPhotos() {
            runOnUiThread(() -> { if (hasRecentPhotosPermission()) notifyRecentPhotos(); });
        }

        @JavascriptInterface
        public void requestHistoryExport(String fileName) {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/zip")
                    .putExtra(Intent.EXTRA_TITLE, fileName);
                try {
                    startActivityForResult(intent, EXPORT_HISTORY);
                } catch (ActivityNotFoundException ignored) {
                    reportExport("error");
                }
            });
        }

        @JavascriptInterface
        public boolean writeHistoryExport(String bytes) { return historyExport.append(bytes); }

        @JavascriptInterface
        public boolean finishHistoryExport() { return historyExport.close(); }

        // 聊天数据的原生文件影子镜像：WebView IndexedDB 被系统清空时用于恢复。
        @JavascriptInterface
        public String chatStorage(String method, String json) {
            return chatStorage.request(storageOwner, method, json);
        }

        @JavascriptInterface
        public String shadowList(String dir) { return shadow.list(dir); }

        @JavascriptInterface
        public String shadowReadChunk(String path, long offset) {
            return shadow.readChunk(path, offset);
        }

        @JavascriptInterface
        public boolean shadowClearAll() { return shadow.clearAll(); }

        @JavascriptInterface
        public void requestImageSavePermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                    reportImageSavePermission(true);
                } else {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, WRITE_IMAGES);
                }
            });
        }

        @JavascriptInterface
        public boolean beginImageSave(String name, String mime) { return imageSave.begin(name, mime); }

        @JavascriptInterface
        public boolean writeImageSave(String bytes) { return imageSave.append(bytes); }

        @JavascriptInterface
        public boolean finishImageSave(boolean keep) { return imageSave.finish(keep); }

        @JavascriptInterface
        public void requestRecording() {
            runOnUiThread(() -> {
                if (granted(Manifest.permission.RECORD_AUDIO)) {
                    startRecording();
                } else {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE);
                }
            });
        }

        @JavascriptInterface
        public boolean finishRecording(boolean keep) { return recorder.finish(keep); }

        @JavascriptInterface
        public double recordingLevel() { return recorder.level(); }

        @JavascriptInterface
        public void setSelectionExclusion(
            float startLeft,
            float startTop,
            float startRight,
            float startBottom,
            float endLeft,
            float endTop,
            float endRight,
            float endBottom,
            boolean active
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
            runOnUiThread(() -> {
                if (webView == null) return;
                if (!active) {
                    webView.setSystemGestureExclusionRects(Collections.emptyList());
                    return;
                }
                float density = getResources().getDisplayMetrics().density;
                List<Rect> rects = new ArrayList<>(2);
                int w = webView.getWidth();
                int h = webView.getHeight();
                if (startRight > startLeft && startBottom > startTop) {
                    rects.add(new Rect(
                        Math.max(0, Math.round(startLeft * density)),
                        Math.max(0, Math.round(startTop * density)),
                        Math.min(w, Math.round(startRight * density)),
                        Math.min(h, Math.round(startBottom * density))
                    ));
                }
                if (endRight > endLeft && endBottom > endTop) {
                    rects.add(new Rect(
                        Math.max(0, Math.round(endLeft * density)),
                        Math.max(0, Math.round(endTop * density)),
                        Math.min(w, Math.round(endRight * density)),
                        Math.min(h, Math.round(endBottom * density))
                    ));
                }
                webView.setSystemGestureExclusionRects(rects);
            });
        }

        @JavascriptInterface
        public void syncKeepAlive(String payloadJson) {
            boolean enabled = false;
            String sessionsJson = "[]";
            int activeCount = 0;
            boolean zh = true;
            if (payloadJson != null && !payloadJson.isEmpty()) {
                try {
                    JSONObject payload = new JSONObject(payloadJson);
                    enabled = payload.optBoolean("enabled", false);
                    JSONArray sessions = payload.optJSONArray("sessions");
                    if (sessions != null) {
                        sessionsJson = sessions.toString();
                        activeCount = sessions.length();
                    }
                    String locale = payload.optString("locale", "");
                    zh = locale.isEmpty() || locale.startsWith("zh");
                } catch (JSONException ignored) {
                }
            }
            final boolean finalEnabled = enabled;
            final String finalSessionsJson = sessionsJson;
            final int finalCount = activeCount;
            final boolean finalZh = zh;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                updateRendererPriority(finalEnabled && finalCount > 0);
                StreamKeepAliveService.sync(
                    MainActivity.this,
                    finalEnabled,
                    finalSessionsJson,
                    finalCount,
                    finalZh
                );
            });
        }

        @JavascriptInterface
        public void notifyBackgroundEvent(String payloadJson) {
            if (isForeground || !hasNotificationPermission()) return;
            StreamKeepAliveService.showBackgroundAlert(MainActivity.this, payloadJson);
        }

        @JavascriptInterface
        public void clearSessionNotification(String sessionId) {
            StreamKeepAliveService.clearSessionNotification(MainActivity.this, sessionId);
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            if (Build.VERSION.SDK_INT < 33) return;
            runOnUiThread(() -> {
                if (isDestroyed() || granted(Manifest.permission.POST_NOTIFICATIONS)) return;
                requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATIONS
                );
            });
        }

        @JavascriptInterface
        public boolean areNotificationsEnabled() {
            return hasNotificationPermission();
        }

        @JavascriptInterface
        public boolean isIgnoringBatteryOptimizations() {
            PowerManager pm = getSystemService(PowerManager.class);
            return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void openBatteryOptimizationSettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    try {
                        startActivity(new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", getPackageName(), null)
                        ));
                    } catch (ActivityNotFoundException ignoredAgain) {
                    }
                }
            });
        }
    }

    private boolean hasNotificationPermission() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        boolean channelEnabled = manager == null || manager.areNotificationsEnabled();
        if (!channelEnabled) return false;
        return Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS);
    }

    private void updateRendererPriority(boolean important) {
        if (webView == null || isDestroyed()) return;
        if (important) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        } else {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        }
    }

    private void handleOpenSessionIntent(Intent intent) {
        if (intent == null) return;
        String sessionId = intent.getStringExtra(StreamKeepAliveService.EXTRA_SESSION_ID);
        if (sessionId == null || sessionId.isEmpty()) return;
        StreamKeepAliveService.clearSessionNotification(this, sessionId);
        if (webPageReady && webView != null && !isDestroyed()) {
            dispatchOpenSession(sessionId);
        } else {
            pendingOpenSessionId = sessionId;
        }
    }

    private void dispatchOpenSession(String sessionId) {
        if (webView == null || isDestroyed() || sessionId == null || sessionId.isEmpty()) return;
        try {
            JSONObject detail = new JSONObject().put("sessionId", sessionId);
            String quotedId = JSONObject.quote(sessionId);
            String detailJson = detail.toString();
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript(
                    "window.__elsewherePendingOpenSession=" + quotedId
                    + ";window.dispatchEvent(new CustomEvent('android-open-session',{detail:"
                    + detailJson + "}))",
                    null
                );
            });
        } catch (JSONException ignored) {
        }
    }

    private void dispatchStopStream(String sessionId) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("sessionId", sessionId == null ? JSONObject.NULL : sessionId);
            String detailJson = detail.toString();
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('android-stop-stream',{detail:"
                    + detailJson + "}))",
                    null
                );
            });
        } catch (JSONException ignored) {
        }
    }

    private void emitBalanceResult(String id, boolean ok, int status, String body) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("id", id);
            payload.put("ok", ok);
            payload.put("status", status);
            payload.put("body", body);
            String json = payload.toString();
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('android-balance',{detail:" + json + "}))",
                    null);
            });
        } catch (JSONException ignored) {
        }
    }
}
