package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Downloads, caches, and serves Pyodide runtime and packages under App private storage. */
final class PyodideRuntimeStore {
    static final String VERSION = "0.27.6";
    private static final String CDN_BASE = "https://cdn.jsdelivr.net/pyodide/v" + VERSION + "/full/";
    private static final String[] CORE_FILES = {
        "pyodide.js",
        "pyodide.asm.js",
        "pyodide.asm.wasm",
        "python_stdlib.zip",
        "pyodide-lock.json",
    };
    private static final long ESTIMATED_CORE_BYTES = 13_800_000L;
    private static final int MAX_WHEEL_FILE_BYTES = 64 * 1024 * 1024;

    private final File rootDir;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Object downloadLock = new Object();
    private final Map<String, ActiveBatch> fileBatches = new ConcurrentHashMap<>();

    private volatile boolean downloading;
    private volatile long downloadedBytes;
    private volatile long totalBytes = ESTIMATED_CORE_BYTES;
    private volatile String lastError = "";
    private volatile AtomicBoolean currentDownloadCancel;
    private volatile HttpURLConnection currentDownloadConn;

    PyodideRuntimeStore(Context context) {
        this.rootDir = new File(new File(context.getFilesDir(), "pyodide"), VERSION);
    }

    String getStatusJson() {
        boolean installed = isCoreInstalled();
        long cachedBytes = computeDirectorySize(rootDir);
        double progress;
        if (installed && !downloading) {
            progress = 1.0;
        } else if (downloading && totalBytes > 0) {
            progress = Math.max(0.0, Math.min(1.0, (double) downloadedBytes / (double) totalBytes));
        } else {
            progress = 0.0;
        }
        try {
            JSONObject obj = new JSONObject();
            obj.put("version", VERSION);
            obj.put("installed", installed);
            obj.put("downloading", downloading);
            obj.put("progress", progress);
            obj.put("downloadedBytes", downloadedBytes);
            obj.put("totalBytes", totalBytes);
            obj.put("cachedBytes", cachedBytes);
            obj.put("error", lastError != null ? lastError : "");
            return safeJson(obj);
        } catch (JSONException ignored) {
            return "{}";
        }
    }

    void beginDownload(Consumer<String> emitStatus) {
        synchronized (downloadLock) {
            if (downloading) {
                if (emitStatus != null) {
                    emitStatus.accept(getStatusJson());
                }
                return;
            }
            if (isCoreInstalled()) {
                lastError = "";
                if (emitStatus != null) {
                    emitStatus.accept(getStatusJson());
                }
                return;
            }
            downloading = true;
            downloadedBytes = 0;
            totalBytes = ESTIMATED_CORE_BYTES;
            lastError = "";
            AtomicBoolean cancelled = new AtomicBoolean(false);
            currentDownloadCancel = cancelled;
            if (emitStatus != null) {
                emitStatus.accept(getStatusJson());
            }
            workers.execute(() -> runCoreDownload(cancelled, emitStatus));
        }
    }

    void cancelDownload(Consumer<String> emitStatus) {
        AtomicBoolean cancelled = currentDownloadCancel;
        if (cancelled != null) {
            cancelled.set(true);
        }
        HttpURLConnection conn = currentDownloadConn;
        if (conn != null) {
            conn.disconnect();
        }
        synchronized (downloadLock) {
            downloading = false;
            downloadedBytes = 0;
            lastError = "";
            currentDownloadCancel = null;
            currentDownloadConn = null;
        }
        if (emitStatus != null) {
            emitStatus.accept(getStatusJson());
        }
    }

    boolean clearCache(Consumer<String> emitStatus) {
        cancelDownload(null);
        boolean deleted = deleteRecursively(rootDir);
        synchronized (downloadLock) {
            downloadedBytes = 0;
            totalBytes = ESTIMATED_CORE_BYTES;
            lastError = "";
        }
        if (emitStatus != null) {
            emitStatus.accept(getStatusJson());
        }
        return deleted;
    }

    boolean ensureFiles(String requestId, String filesJsonArray, Consumer<String> emitResult) {
        if (requestId == null || requestId.isEmpty() || filesJsonArray == null || emitResult == null) {
            return false;
        }
        List<String> requested = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(filesJsonArray);
            for (int i = 0; i < array.length(); i++) {
                String rel = array.optString(i, "");
                if (!isSafeRelativePath(rel)) {
                    return false;
                }
                if (!requested.contains(rel)) {
                    requested.add(rel);
                }
            }
        } catch (JSONException ignored) {
            return false;
        }
        ActiveBatch batch = new ActiveBatch();
        if (fileBatches.putIfAbsent(requestId, batch) != null) {
            return false;
        }
        workers.execute(() -> runEnsureBatch(requestId, requested, batch, emitResult));
        return true;
    }

    void cancelEnsureFiles(String requestId) {
        if (requestId == null) {
            return;
        }
        ActiveBatch batch = fileBatches.remove(requestId);
        if (batch == null) {
            return;
        }
        batch.cancelled = true;
        HttpURLConnection conn = batch.connection;
        if (conn != null) {
            conn.disconnect();
        }
    }

    WebResourceResponse openAsset(String path) {
        if (path == null || !path.startsWith("/pyodide/")) {
            return null;
        }
        String rel = path.substring("/pyodide/".length());
        if (!isSafeRelativePath(rel)) {
            return notFound();
        }
        File target = resolveInsideRoot(rel);
        if (target == null || !target.isFile()) {
            return notFound();
        }
        try {
            FileInputStream stream = new FileInputStream(target);
            String mime = resolveMime(rel);
            Map<String, String> headers = Map.of(
                "Cache-Control", "public, max-age=31536000, immutable",
                "Cross-Origin-Resource-Policy", "same-origin"
            );
            return new WebResourceResponse(mime, null, 200, "OK", headers, stream);
        } catch (IOException ignored) {
            return notFound();
        }
    }

    void close() {
        cancelDownload(null);
        for (String id : fileBatches.keySet()) {
            cancelEnsureFiles(id);
        }
        workers.shutdownNow();
    }

    private void runCoreDownload(AtomicBoolean cancelled, Consumer<String> emitStatus) {
        try {
            if (!rootDir.exists() && !rootDir.mkdirs()) {
                throw new IOException("Unable to create cache directory");
            }
            long completedBase = 0;
            for (String fileName : CORE_FILES) {
                if (cancelled.get()) {
                    return;
                }
                File target = resolveInsideRoot(fileName);
                if (target == null) {
                    throw new IOException("Invalid cache path");
                }
                if (target.isFile() && target.length() > 0) {
                    completedBase += target.length();
                    downloadedBytes = completedBase;
                    if (totalBytes < completedBase) {
                        totalBytes = completedBase;
                    }
                    if (emitStatus != null) {
                        emitStatus.accept(getStatusJson());
                    }
                    continue;
                }
                long baseSnapshot = completedBase;
                long size = downloadToFile(
                    CDN_BASE + fileName,
                    target,
                    cancelled,
                    conn -> currentDownloadConn = conn,
                    bytesRead -> {
                        downloadedBytes = baseSnapshot + bytesRead;
                        if (totalBytes < downloadedBytes) {
                            totalBytes = downloadedBytes + 1_048_576L;
                        }
                        if (emitStatus != null) {
                            emitStatus.accept(getStatusJson());
                        }
                    }
                );
                completedBase += size;
                downloadedBytes = completedBase;
            }
            if (!cancelled.get()) {
                synchronized (downloadLock) {
                    downloading = false;
                    totalBytes = Math.max(downloadedBytes, 1L);
                    lastError = "";
                    currentDownloadCancel = null;
                    currentDownloadConn = null;
                }
                if (emitStatus != null) {
                    emitStatus.accept(getStatusJson());
                }
            }
        } catch (IOException | RuntimeException error) {
            if (!cancelled.get()) {
                String message = error.getMessage();
                synchronized (downloadLock) {
                    downloading = false;
                    lastError = message != null && !message.isEmpty() ? message : error.getClass().getSimpleName();
                    currentDownloadCancel = null;
                    currentDownloadConn = null;
                }
                if (emitStatus != null) {
                    emitStatus.accept(getStatusJson());
                }
            }
        }
    }

    private void runEnsureBatch(
        String requestId,
        List<String> files,
        ActiveBatch batch,
        Consumer<String> emitResult
    ) {
        try {
            if (!rootDir.exists() && !rootDir.mkdirs()) {
                throw new IOException("Unable to create cache directory");
            }
            AtomicBoolean cancelled = new AtomicBoolean(false);
            for (String rel : files) {
                if (batch.cancelled) {
                    cancelled.set(true);
                    return;
                }
                File target = resolveInsideRoot(rel);
                if (target == null) {
                    throw new IOException("Invalid package path: " + rel);
                }
                if (target.isFile() && target.length() > 0) {
                    continue;
                }
                downloadToFile(
                    CDN_BASE + rel,
                    target,
                    cancelled,
                    conn -> {
                        batch.connection = conn;
                        if (batch.cancelled) {
                            cancelled.set(true);
                            conn.disconnect();
                        }
                    },
                    null
                );
            }
            if (!batch.cancelled) {
                emitEnsureResult(requestId, true, null, emitResult);
            }
        } catch (IOException | RuntimeException error) {
            if (!batch.cancelled) {
                String message = error.getMessage();
                emitEnsureResult(
                    requestId,
                    false,
                    message != null && !message.isEmpty() ? message : error.getClass().getSimpleName(),
                    emitResult
                );
            }
        } finally {
            batch.connection = null;
            fileBatches.remove(requestId, batch);
        }
    }

    private static long downloadToFile(
        String rawUrl,
        File target,
        AtomicBoolean cancelled,
        Consumer<HttpURLConnection> registerConn,
        java.util.function.LongConsumer onProgress
    ) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Unable to create parent directory");
        }
        File temp = new File(parent, target.getName() + ".tmp");
        if (temp.exists()) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
        }
        HttpURLConnection conn = null;
        long lastEmitMs = 0L;
        try {
            conn = (HttpURLConnection) new URL(rawUrl).openConnection();
            registerConn.accept(conn);
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(60_000);
            conn.setRequestMethod("GET");
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("HTTP " + status);
            }
            long total = 0;
            try (InputStream input = conn.getInputStream();
                 FileOutputStream output = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16_384];
                int count;
                while (!cancelled.get() && (count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_WHEEL_FILE_BYTES) {
                        throw new IOException("File too large");
                    }
                    output.write(buffer, 0, count);
                    if (onProgress != null) {
                        long now = System.currentTimeMillis();
                        if (now - lastEmitMs >= 120) {
                            lastEmitMs = now;
                            onProgress.accept(total);
                        }
                    }
                }
                output.flush();
            }
            if (cancelled.get()) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                throw new IOException("Cancelled");
            }
            if (target.exists() && !target.delete()) {
                throw new IOException("Unable to replace existing cache file");
            }
            if (!temp.renameTo(target)) {
                throw new IOException("Unable to finalize cache file");
            }
            if (onProgress != null) {
                onProgress.accept(total);
            }
            return total;
        } catch (IOException | RuntimeException error) {
            if (temp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
            throw error;
        } finally {
            registerConn.accept(null);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private boolean isCoreInstalled() {
        if (!rootDir.isDirectory()) {
            return false;
        }
        for (String name : CORE_FILES) {
            File file = new File(rootDir, name);
            if (!file.isFile() || file.length() == 0) {
                return false;
            }
        }
        return true;
    }

    private File resolveInsideRoot(String relative) {
        try {
            String baseCanonical = rootDir.getCanonicalPath();
            File candidate = new File(rootDir, relative);
            String candidateCanonical = candidate.getCanonicalPath();
            if (!candidateCanonical.startsWith(baseCanonical + File.separator)) {
                return null;
            }
            return candidate;
        } catch (IOException ignored) {
            return null;
        }
    }

    private static boolean isSafeRelativePath(String path) {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\") || path.contains("..")) {
            return false;
        }
        for (int i = 0; i < path.length(); i++) {
            char ch = path.charAt(i);
            boolean valid = (ch >= 'a' && ch <= 'z')
                || (ch >= 'A' && ch <= 'Z')
                || (ch >= '0' && ch <= '9')
                || ch == '.' || ch == '_' || ch == '-' || ch == '/';
            if (!valid) {
                return false;
            }
        }
        return true;
    }

    private static String resolveMime(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".wasm")) {
            return "application/wasm";
        }
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".zip") || lower.endsWith(".whl")) {
            return "application/zip";
        }
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        return "application/octet-stream";
    }

    private static long computeDirectorySize(File dir) {
        if (dir == null || !dir.exists()) {
            return 0L;
        }
        if (dir.isFile()) {
            return dir.getName().endsWith(".tmp") ? 0L : dir.length();
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return 0L;
        }
        long sum = 0L;
        for (File child : children) {
            sum += computeDirectorySize(child);
        }
        return sum;
    }

    private static boolean deleteRecursively(File target) {
        if (target == null || !target.exists()) {
            return true;
        }
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        return target.delete();
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            404,
            "Not Found",
            Map.of(),
            new ByteArrayInputStream(new byte[0])
        );
    }

    private static void emitEnsureResult(String id, boolean ok, String error, Consumer<String> emit) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("ok", ok);
            if (error != null && !error.isEmpty()) {
                obj.put("error", error);
            }
            emit.accept(safeJson(obj));
        } catch (JSONException ignored) {
        }
    }

    private static String safeJson(JSONObject json) {
        return json.toString()
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029");
    }

    private static final class ActiveBatch {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
    }
}
