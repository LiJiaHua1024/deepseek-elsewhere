package io.github.lijiahua1024.dsreplica;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.IllegalCharsetNameException;
import java.nio.charset.StandardCharsets;
import java.nio.charset.UnsupportedCharsetException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/** Executes one-shot HTTP(S) requests on a background thread for the bundled WebView. */
final class NativeHttpTransport {
    private static final int DEFAULT_TIMEOUT_MS = 15_000;
    private static final int MIN_TIMEOUT_MS = 1_000;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
    private static final String DEFAULT_USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

    private final Map<String, Call> activeCalls = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();

    boolean begin(String requestId, String payloadJson, Consumer<String> emit) {
        if (requestId == null || requestId.isEmpty() || payloadJson == null || emit == null) {
            return false;
        }
        try {
            JSONObject payload = new JSONObject(payloadJson);
            String rawUrl = payload.optString("url", "");
            URI initialUri = parseWebUri(rawUrl);
            if (initialUri == null) {
                return false;
            }
            String method = payload.optString("method", "GET").toUpperCase(Locale.ROOT);
            if (!"GET".equals(method) && !"POST".equals(method) && !"PUT".equals(method) && !"PATCH".equals(method) && !"DELETE".equals(method)) {
                return false;
            }
            int timeoutMs = payload.has("timeoutMs")
                ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, payload.optInt("timeoutMs", DEFAULT_TIMEOUT_MS)))
                : DEFAULT_TIMEOUT_MS;
            String body = payload.isNull("body") ? null : payload.optString("body", null);
            byte[] bodyBytes = body != null ? body.getBytes(StandardCharsets.UTF_8) : null;
            List<HeaderEntry> headers = parseHeaders(payload.optJSONObject("headers"));

            Call call = new Call();
            Call previous = activeCalls.putIfAbsent(requestId, call);
            if (previous != null) {
                return false;
            }
            workers.execute(() -> run(requestId, call, initialUri, method, headers, bodyBytes, timeoutMs, emit));
            return true;
        } catch (JSONException | IllegalArgumentException ignored) {
            return false;
        }
    }

    boolean beginMultipartAudio(String requestId, String payloadJson, byte[] wavBytes, Consumer<String> emit) {
        if (requestId == null || requestId.isEmpty() || payloadJson == null || wavBytes == null
                || wavBytes.length == 0 || emit == null) {
            return false;
        }
        try {
            JSONObject payload = new JSONObject(payloadJson);
            URI initialUri = parseWebUri(payload.optString("url", ""));
            if (initialUri == null) {
                return false;
            }
            int timeoutMs = payload.has("timeoutMs")
                ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, payload.optInt("timeoutMs", 60_000)))
                : 60_000;
            String fileField = payload.optString("fileField", "file");
            if (fileField.isEmpty()) fileField = "file";
            String fileName = payload.optString("fileName", "recording.wav");
            if (fileName.isEmpty()) fileName = "recording.wav";
            String fileMime = payload.optString("fileMime", "audio/wav");
            if (fileMime.isEmpty()) fileMime = "audio/wav";

            String boundary = "----ElsewhereBoundary" + UUID.randomUUID().toString().replace("-", "");
            List<HeaderEntry> headers = parseHeaders(payload.optJSONObject("headers"));
            headers.removeIf(entry -> "content-type".equalsIgnoreCase(entry.name));
            headers.add(new HeaderEntry("Content-Type", "multipart/form-data; boundary=" + boundary));

            ByteArrayOutputStream multipart = new ByteArrayOutputStream();
            JSONObject fields = payload.optJSONObject("fields");
            if (fields != null) {
                Iterator<String> keys = fields.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    if (name == null || name.isEmpty() || fields.isNull(name)) continue;
                    String value = fields.optString(name, "");
                    writeMultipartTextField(multipart, boundary, name, value);
                }
            }
            writeMultipartFileField(multipart, boundary, fileField, fileName, fileMime, wavBytes);
            multipart.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
            byte[] bodyBytes = multipart.toByteArray();

            Call call = new Call();
            Call previous = activeCalls.putIfAbsent(requestId, call);
            if (previous != null) {
                return false;
            }
            workers.execute(() -> run(requestId, call, initialUri, "POST", headers, bodyBytes, timeoutMs, emit));
            return true;
        } catch (JSONException | IOException | IllegalArgumentException ignored) {
            return false;
        }
    }

    private static void writeMultipartTextField(
        ByteArrayOutputStream out,
        String boundary,
        String name,
        String value
    ) throws IOException {
        String safeName = sanitizeQuotedHeaderValue(name);
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(("Content-Disposition: form-data; name=\"" + safeName + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private static void writeMultipartFileField(
        ByteArrayOutputStream out,
        String boundary,
        String fieldName,
        String fileName,
        String mimeType,
        byte[] bytes
    ) throws IOException {
        String safeField = sanitizeQuotedHeaderValue(fieldName);
        String safeFile = sanitizeQuotedHeaderValue(fileName);
        String safeMime = mimeType.replace("\r", "").replace("\n", "");
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(("Content-Disposition: form-data; name=\"" + safeField + "\"; filename=\"" + safeFile + "\"\r\n")
            .getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Type: " + safeMime + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private static String sanitizeQuotedHeaderValue(String value) {
        return value.replace("\r", "").replace("\n", "").replace("\"", "_");
    }

    private void run(
        String requestId,
        Call call,
        URI initialUri,
        String initialMethod,
        List<HeaderEntry> headers,
        byte[] initialBody,
        int timeoutMs,
        Consumer<String> emit
    ) {
        URI currentUri = initialUri;
        String currentMethod = initialMethod;
        byte[] currentBody = initialBody;
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
                conn.setConnectTimeout(timeoutMs);
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

                if (!"GET".equals(currentMethod) && currentBody != null) {
                    byte[] data = currentBody;
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
                            emitError(requestId, "Too many redirects", emit);
                        }
                        return;
                    }
                    String location = conn.getHeaderField("Location");
                    if (location == null || location.isEmpty()) {
                        if (!call.cancelled) {
                            emitError(requestId, "Redirect missing Location header", emit);
                        }
                        return;
                    }
                    URI nextUri = parseWebUri(currentUri.resolve(location).toString());
                    if (nextUri == null) {
                        if (!call.cancelled) {
                            emitError(requestId, "Invalid redirect target", emit);
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
                boolean truncated = false;
                String text = "";
                try (InputStream input = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                    if (input != null) {
                        ByteArrayOutputStream output = new ByteArrayOutputStream();
                        byte[] buffer = new byte[8192];
                        int total = 0;
                        int count;
                        while (!call.cancelled && total < MAX_BODY_BYTES
                                && (count = input.read(buffer, 0, Math.min(buffer.length, MAX_BODY_BYTES - total))) != -1) {
                            output.write(buffer, 0, count);
                            total += count;
                        }
                        if (!call.cancelled && total == MAX_BODY_BYTES && input.read() != -1) {
                            truncated = true;
                        }
                        text = new String(output.toByteArray(), resolveCharset(contentType));
                    }
                }
                if (!call.cancelled) {
                    emitResponse(requestId, status >= 200 && status < 300, status, contentType, responseHeaders, text, truncated, emit);
                }
                return;
            }
        } catch (IOException | RuntimeException error) {
            if (!call.cancelled) {
                String message = error.getMessage();
                emitError(requestId, message != null && !message.isEmpty() ? message : error.getClass().getSimpleName(), emit);
            }
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
            activeCalls.remove(requestId, call);
        }
    }

    void cancel(String requestId) {
        Call call = activeCalls.remove(requestId);
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
                    || uri.getUserInfo() != null) {
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
            || "x-subscription-token".equals(lowerName);
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

    private static Charset resolveCharset(String contentType) {
        if (contentType == null || contentType.isEmpty()) {
            return StandardCharsets.UTF_8;
        }
        String[] parts = contentType.split(";");
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i].trim();
            if (part.regionMatches(true, 0, "charset=", 0, 8)) {
                String raw = part.substring(8).trim();
                if (raw.length() >= 2 && ((raw.startsWith("\"") && raw.endsWith("\""))
                        || (raw.startsWith("'") && raw.endsWith("'")))) {
                    raw = raw.substring(1, raw.length() - 1).trim();
                }
                if (!raw.isEmpty()) {
                    try {
                        return Charset.forName(raw);
                    } catch (IllegalCharsetNameException | UnsupportedCharsetException ignored) {
                        return StandardCharsets.UTF_8;
                    }
                }
            }
        }
        return StandardCharsets.UTF_8;
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

    private static void emitResponse(
        String id,
        boolean ok,
        int status,
        String contentType,
        JSONObject headers,
        String text,
        boolean truncated,
        Consumer<String> emit
    ) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("ok", ok);
            json.put("status", status);
            json.put("contentType", contentType != null ? contentType : "");
            json.put("headers", headers != null ? headers : new JSONObject());
            json.put("text", text != null ? text : "");
            json.put("truncated", truncated);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitError(String id, String message, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("ok", false);
            json.put("status", 0);
            json.put("contentType", "");
            json.put("text", "");
            json.put("error", message);
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
