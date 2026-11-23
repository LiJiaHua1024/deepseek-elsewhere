package io.github.lijiahua1024.dsreplica;

import android.util.Base64;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/** Streams generic HTTP(S) responses in base64 chunks to the bundled WebView. */
final class NativeHttpStreamTransport {
    private static final int DEFAULT_TIMEOUT_MS = 60_000;
    private static final int MIN_TIMEOUT_MS = 1_000;
    private static final int MAX_TIMEOUT_MS = 300_000;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_STREAM_BYTES = 16 * 1024 * 1024;
    private static final String DEFAULT_USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

    private final Map<String, Call> activeCalls = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();

    boolean begin(String streamId, String payloadJson, Consumer<String> emit) {
        if (streamId == null || streamId.isEmpty() || payloadJson == null || emit == null) {
            return false;
        }
        try {
            JSONObject payload = new JSONObject(payloadJson);
            URI initialUri = parseWebUri(payload.optString("url", ""));
            if (initialUri == null) {
                return false;
            }
            String method = payload.optString("method", "GET").toUpperCase(Locale.ROOT);
            if (!"GET".equals(method) && !"POST".equals(method) && !"DELETE".equals(method)) {
                return false;
            }
            int timeoutMs = payload.has("timeoutMs")
                ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, payload.optInt("timeoutMs", DEFAULT_TIMEOUT_MS)))
                : DEFAULT_TIMEOUT_MS;
            String body = payload.isNull("body") ? null : payload.optString("body", null);
            List<HeaderEntry> headers = parseHeaders(payload.optJSONObject("headers"));

            Call call = new Call();
            if (activeCalls.putIfAbsent(streamId, call) != null) {
                return false;
            }
            workers.execute(() -> run(streamId, call, initialUri, method, headers, body, timeoutMs, emit));
            return true;
        } catch (JSONException | IllegalArgumentException ignored) {
            return false;
        }
    }

    private void run(
        String streamId,
        Call call,
        URI initialUri,
        String initialMethod,
        List<HeaderEntry> headers,
        String initialBody,
        int timeoutMs,
        Consumer<String> emit
    ) {
        URI currentUri = initialUri;
        String currentMethod = initialMethod;
        String currentBody = initialBody;
        int redirects = 0;
        HttpURLConnection conn = null;
        try {
            while (true) {
                if (call.cancelled) {
                    return;
                }
                conn = (HttpURLConnection) currentUri.toURL().openConnection();
                call.connection = conn;
                if (call.cancelled) {
                    return;
                }
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(Math.min(timeoutMs, 20_000));
                conn.setReadTimeout(timeoutMs);
                conn.setRequestMethod(currentMethod);

                boolean hostChanged = !sameOrigin(initialUri, currentUri);
                boolean hasUserAgent = false;
                for (HeaderEntry entry : headers) {
                    String lower = entry.name.toLowerCase(Locale.ROOT);
                    if ("accept-encoding".equals(lower)) {
                        continue;
                    }
                    if (hostChanged && isSensitiveHeader(lower)) {
                        continue;
                    }
                    if ("user-agent".equals(lower)) {
                        hasUserAgent = true;
                    }
                    conn.setRequestProperty(entry.name, entry.value);
                }
                if (!hasUserAgent) {
                    conn.setRequestProperty("User-Agent", DEFAULT_USER_AGENT);
                }

                if ("POST".equals(currentMethod)
                        || ("DELETE".equals(currentMethod) && currentBody != null && !currentBody.isEmpty())) {
                    byte[] data = currentBody != null
                        ? currentBody.getBytes(StandardCharsets.UTF_8)
                        : new byte[0];
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(data.length);
                    try (OutputStream output = conn.getOutputStream()) {
                        if (data.length > 0) {
                            output.write(data);
                        }
                    }
                }

                int status = conn.getResponseCode();
                if (isRedirect(status)) {
                    if (redirects >= MAX_REDIRECTS) {
                        if (!call.cancelled) {
                            emitError(streamId, "Too many redirects", emit);
                        }
                        return;
                    }
                    String location = conn.getHeaderField("Location");
                    if (location == null || location.isEmpty()) {
                        if (!call.cancelled) {
                            emitError(streamId, "Redirect missing Location header", emit);
                        }
                        return;
                    }
                    URI nextUri = parseWebUri(currentUri.resolve(location).toString());
                    if (nextUri == null) {
                        if (!call.cancelled) {
                            emitError(streamId, "Invalid redirect target", emit);
                        }
                        return;
                    }
                    if (status == 303 || ((status == 301 || status == 302) && "POST".equals(currentMethod))) {
                        currentMethod = "GET";
                        currentBody = null;
                    }
                    currentUri = nextUri;
                    redirects++;
                    conn.disconnect();
                    call.connection = null;
                    conn = null;
                    continue;
                }

                String contentType = conn.getContentType();
                JSONObject responseHeaders = collectResponseHeaders(conn);
                if (!call.cancelled) {
                    emitHeaders(streamId, status, contentType, responseHeaders, emit);
                }
                try (InputStream input = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                    if (input != null) {
                        byte[] buffer = new byte[8192];
                        int total = 0;
                        int count;
                        while (!call.cancelled && (count = input.read(buffer)) != -1) {
                            total += count;
                            if (total > MAX_STREAM_BYTES) {
                                if (!call.cancelled) {
                                    emitError(streamId, "Stream size limit exceeded", emit);
                                }
                                return;
                            }
                            if (count > 0 && !call.cancelled) {
                                emitData(streamId, Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP), emit);
                            }
                        }
                    }
                }
                if (!call.cancelled) {
                    emitEnd(streamId, emit);
                }
                return;
            }
        } catch (IOException | RuntimeException error) {
            if (!call.cancelled) {
                String message = error.getMessage();
                emitError(
                    streamId,
                    message != null && !message.isEmpty() ? message : error.getClass().getSimpleName(),
                    emit
                );
            }
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
            activeCalls.remove(streamId, call);
        }
    }

    void cancel(String streamId) {
        Call call = activeCalls.remove(streamId);
        if (call == null) {
            return;
        }
        call.cancelled = true;
        HttpURLConnection conn = call.connection;
        if (conn != null) {
            conn.disconnect();
        }
    }

    void close() {
        workers.shutdownNow();
        for (String id : activeCalls.keySet()) {
            cancel(id);
        }
    }

    private static URI parseWebUri(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) {
            return null;
        }
        try {
            URI uri = URI.create(rawUrl);
            String scheme = uri.getScheme();
            if ((!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))
                    || uri.getHost() == null
                    || uri.getUserInfo() != null
                    || uri.getFragment() != null) {
                return null;
            }
            return uri;
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private static boolean sameOrigin(URI a, URI b) {
        String schemeA = a.getScheme();
        String schemeB = b.getScheme();
        String hostA = a.getHost();
        String hostB = b.getHost();
        if (schemeA == null || schemeB == null || hostA == null || hostB == null) {
            return false;
        }
        return schemeA.equalsIgnoreCase(schemeB)
            && hostA.equalsIgnoreCase(hostB)
            && effectivePort(a) == effectivePort(b);
    }

    private static int effectivePort(URI uri) {
        int port = uri.getPort();
        if (port != -1) {
            return port;
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static boolean isSensitiveHeader(String lowerName) {
        return "authorization".equals(lowerName)
            || "x-api-key".equals(lowerName)
            || "x-subscription-token".equals(lowerName)
            || "cookie".equals(lowerName);
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static List<HeaderEntry> parseHeaders(JSONObject headersObj) {
        List<HeaderEntry> list = new ArrayList<>();
        if (headersObj == null) {
            return list;
        }
        Iterator<String> keys = headersObj.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            if (name != null && !name.isEmpty() && !headersObj.isNull(name)) {
                String value = headersObj.optString(name, null);
                if (value != null) {
                    list.add(new HeaderEntry(name, value));
                }
            }
        }
        return list;
    }

    private static JSONObject collectResponseHeaders(HttpURLConnection conn) {
        JSONObject map = new JSONObject();
        Map<String, List<String>> fields = conn.getHeaderFields();
        if (fields == null) {
            return map;
        }
        for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
            String key = entry.getKey();
            List<String> values = entry.getValue();
            if (key == null || values == null || values.isEmpty()) {
                continue;
            }
            String lower = key.toLowerCase(Locale.ROOT);
            String joined = String.join(", ", values);
            try {
                map.put(lower, joined);
            } catch (JSONException ignored) {
            }
        }
        return map;
    }

    private static void emitHeaders(
        String id,
        int status,
        String contentType,
        JSONObject headers,
        Consumer<String> emit
    ) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "headers");
            json.put("status", status);
            json.put("contentType", contentType != null ? contentType : "");
            json.put("headers", headers != null ? headers : new JSONObject());
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitData(String id, String bytesBase64, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "data");
            json.put("bytes", bytesBase64);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitEnd(String id, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "end");
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitError(String id, String message, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "error");
            json.put("message", message != null ? message : "");
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static String safeJson(JSONObject json) {
        return json.toString()
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029");
    }

    private static final class HeaderEntry {
        final String name;
        final String value;

        HeaderEntry(String name, String value) {
            this.name = name;
            this.value = value;
        }
    }

    private static final class Call {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
    }
}
