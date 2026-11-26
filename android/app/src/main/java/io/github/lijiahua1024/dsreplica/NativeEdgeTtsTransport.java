package io.github.lijiahua1024.dsreplica;

import android.util.Base64;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Executes Edge online TTS synthesis (TLS RFC 6455 WebSocket) and voice list
 * fetching directly from Java without extra dependencies.
 */
final class NativeEdgeTtsTransport {
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int MAX_AUDIO_BYTES = 16 * 1024 * 1024;
    private static final Pattern SHORT_VOICE_PATTERN =
        Pattern.compile("^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Map<String, ActiveCall> activeCalls = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();

    boolean synthesize(String requestId, String payloadJson, Consumer<String> emit) {
        if (requestId == null || requestId.isEmpty() || payloadJson == null || emit == null) {
            return false;
        }
        try {
            JSONObject payload = new JSONObject(payloadJson);
            String text = payload.optString("text", "");
            String voice = payload.optString("voice", "zh-CN-XiaoxiaoNeural");
            String rate = payload.optString("rate", "+0%");
            if (text.trim().isEmpty()) {
                return false;
            }
            if (!rate.matches("^[+-]\\d+%$")) {
                rate = "+0%";
            }
            String fullVoice = normalizeVoiceName(voice);
            String sanitizedText = escapeXml(removeIncompatibleCharacters(text));

            ActiveCall call = new ActiveCall();
            if (activeCalls.putIfAbsent(requestId, call) != null) {
                return false;
            }
            final String finalRate = rate;
            workers.execute(() -> runSynthesis(requestId, call, fullVoice, finalRate, sanitizedText, emit));
            return true;
        } catch (JSONException | IllegalArgumentException ignored) {
            return false;
        }
    }

    boolean fetchVoices(String requestId, Consumer<String> emit) {
        if (requestId == null || requestId.isEmpty() || emit == null) {
            return false;
        }
        ActiveCall call = new ActiveCall();
        if (activeCalls.putIfAbsent(requestId, call) != null) {
            return false;
        }
        workers.execute(() -> runFetchVoices(requestId, call, emit));
        return true;
    }

    void cancel(String requestId) {
        if (requestId == null) return;
        ActiveCall call = activeCalls.remove(requestId);
        if (call != null) {
            call.cancel();
        }
    }

    void close() {
        workers.shutdownNow();
        for (String id : activeCalls.keySet()) {
            cancel(id);
        }
    }

    private void runFetchVoices(String requestId, ActiveCall call, Consumer<String> emit) {
        try {
            for (int attempt = 0; attempt < 2; attempt++) {
                if (call.cancelled) return;
                String urlStr = "https://" + EdgeTtsDrm.BASE_HOST + EdgeTtsDrm.BASE_PATH
                    + "/voices/list?trustedclienttoken=" + EdgeTtsDrm.TRUSTED_CLIENT_TOKEN
                    + "&Sec-MS-GEC=" + EdgeTtsDrm.generateSecMsGec()
                    + "&Sec-MS-GEC-Version=" + EdgeTtsDrm.SEC_MS_GEC_VERSION;
                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                call.httpConn = conn;
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Authority", EdgeTtsDrm.BASE_HOST);
                conn.setRequestProperty("Sec-CH-UA", EdgeTtsDrm.SEC_CH_UA);
                conn.setRequestProperty("Sec-CH-UA-Mobile", "?0");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Sec-Fetch-Site", "none");
                conn.setRequestProperty("Sec-Fetch-Mode", "cors");
                conn.setRequestProperty("Sec-Fetch-Dest", "empty");
                conn.setRequestProperty("User-Agent", EdgeTtsDrm.USER_AGENT);
                conn.setRequestProperty("Accept-Language", EdgeTtsDrm.ACCEPT_LANGUAGE);
                conn.setRequestProperty("Cookie", "muid=" + EdgeTtsDrm.generateMuid() + ";");

                int status = conn.getResponseCode();
                if (status == 403 && attempt == 0 && EdgeTtsDrm.adjustClockSkewFromHttpDate(conn.getHeaderField("Date"))) {
                    conn.disconnect();
                    call.httpConn = null;
                    continue;
                }
                if (status < 200 || status >= 300) {
                    emitVoicesError(requestId, "HTTP " + status, emit);
                    return;
                }
                String body = readStreamUtf8(conn.getInputStream());
                if (!call.cancelled) {
                    emitVoicesSuccess(requestId, body, emit);
                }
                return;
            }
        } catch (IOException | RuntimeException error) {
            if (!call.cancelled) {
                emitVoicesError(requestId, messageOf(error), emit);
            }
        } finally {
            call.cancel();
            activeCalls.remove(requestId, call);
        }
    }

    private void runSynthesis(
        String requestId,
        ActiveCall call,
        String voice,
        String rate,
        String escapedText,
        Consumer<String> emit
    ) {
        try {
            for (int attempt = 0; attempt < 2; attempt++) {
                if (call.cancelled) return;
                try {
                    byte[] audio = performWebSocketSynthesis(call, voice, rate, escapedText);
                    if (!call.cancelled) {
                        if (audio.length == 0) {
                            emitTtsError(requestId, "No audio received from Edge speech service", emit);
                        } else {
                            emitTtsAudio(requestId, audio, emit);
                        }
                    }
                    return;
                } catch (Http403SkewException skewEx) {
                    if (attempt == 0 && EdgeTtsDrm.adjustClockSkewFromHttpDate(skewEx.dateHeader)) {
                        continue;
                    }
                    if (!call.cancelled) {
                        emitTtsError(requestId, "Edge speech rejected token (403)", emit);
                    }
                    return;
                }
            }
        } catch (IOException | RuntimeException error) {
            if (!call.cancelled) {
                emitTtsError(requestId, messageOf(error), emit);
            }
        } finally {
            call.cancel();
            activeCalls.remove(requestId, call);
        }
    }

    private byte[] performWebSocketSynthesis(
        ActiveCall call,
        String voice,
        String rate,
        String escapedText
    ) throws IOException, Http403SkewException {
        SSLSocket ssl = null;
        try {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            ssl = (SSLSocket) factory.createSocket();
            call.socket = ssl;
            ssl.connect(new InetSocketAddress(EdgeTtsDrm.BASE_HOST, 443), CONNECT_TIMEOUT_MS);
            ssl.setSoTimeout(READ_TIMEOUT_MS);
            SSLParameters params = ssl.getSSLParameters();
            params.setServerNames(java.util.Collections.singletonList(new SNIHostName(EdgeTtsDrm.BASE_HOST)));
            ssl.setSSLParameters(params);
            ssl.startHandshake();
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(EdgeTtsDrm.BASE_HOST, ssl.getSession())) {
                throw new IOException("TLS hostname verification failed");
            }

            OutputStream out = ssl.getOutputStream();
            BufferedInputStream in = new BufferedInputStream(ssl.getInputStream(), 16384);

            String connId = connectId();
            String path = EdgeTtsDrm.BASE_PATH + "/edge/v1?TrustedClientToken=" + EdgeTtsDrm.TRUSTED_CLIENT_TOKEN
                + "&ConnectionId=" + connId
                + "&Sec-MS-GEC=" + EdgeTtsDrm.generateSecMsGec()
                + "&Sec-MS-GEC-Version=" + EdgeTtsDrm.SEC_MS_GEC_VERSION;

            byte[] keyBytes = new byte[16];
            RANDOM.nextBytes(keyBytes);
            String wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP);

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(path).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(EdgeTtsDrm.BASE_HOST).append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            req.append("Pragma: no-cache\r\n");
            req.append("Cache-Control: no-cache\r\n");
            req.append("Origin: ").append(EdgeTtsDrm.ORIGIN).append("\r\n");
            req.append("User-Agent: ").append(EdgeTtsDrm.USER_AGENT).append("\r\n");
            req.append("Accept-Language: ").append(EdgeTtsDrm.ACCEPT_LANGUAGE).append("\r\n");
            req.append("Cookie: muid=").append(EdgeTtsDrm.generateMuid()).append(";\r\n");
            req.append("\r\n");
            out.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            out.flush();

            String statusLine = readAsciiLine(in);
            if (statusLine == null) {
                throw new EOFException("Connection closed during handshake");
            }
            int statusCode = parseHttpStatus(statusLine);
            String dateHeader = null;
            String line;
            while ((line = readAsciiLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0 && "date".equalsIgnoreCase(line.substring(0, colon).trim())) {
                    dateHeader = line.substring(colon + 1).trim();
                }
            }
            if (statusCode == 403) {
                throw new Http403SkewException(dateHeader);
            }
            if (statusCode != 101) {
                throw new IOException("WebSocket upgrade failed: " + statusLine);
            }

            String ts = EdgeTtsDrm.formatJsUtcTimestamp();
            String speechConfig = "X-Timestamp:" + ts + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n"
                + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\""
                + "},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n";
            sendWsFrame(out, 0x1, speechConfig.getBytes(StandardCharsets.UTF_8));

            String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>"
                + escapedText
                + "</prosody></voice></speak>";
            String ssmlMsg = "X-RequestId:" + connectId() + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + ts + "Z\r\n"
                + "Path:ssml\r\n\r\n"
                + ssml;
            sendWsFrame(out, 0x1, ssmlMsg.getBytes(StandardCharsets.UTF_8));

            ByteArrayOutputStream audioOut = new ByteArrayOutputStream();
            ByteArrayOutputStream fragmentOut = new ByteArrayOutputStream();
            int fragmentOpcode = -1;

            while (!call.cancelled) {
                int b0 = in.read();
                int b1 = in.read();
                if (b0 < 0 || b1 < 0) {
                    break;
                }
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long payloadLen = b1 & 0x7F;
                if (payloadLen == 126) {
                    payloadLen = ((readByte(in) & 0xFF) << 8) | (readByte(in) & 0xFF);
                } else if (payloadLen == 127) {
                    long len = 0;
                    for (int i = 0; i < 8; i++) {
                        len = (len << 8) | (readByte(in) & 0xFFL);
                    }
                    payloadLen = len;
                }
                if (payloadLen < 0 || payloadLen > MAX_AUDIO_BYTES) {
                    throw new IOException("WebSocket frame too large");
                }
                byte[] maskKey = null;
                if (masked) {
                    maskKey = readExact(in, 4);
                }
                byte[] payload = readExact(in, (int) payloadLen);
                if (maskKey != null) {
                    for (int i = 0; i < payload.length; i++) {
                        payload[i] ^= maskKey[i % 4];
                    }
                }

                if (opcode == 0x8) {
                    break;
                }
                if (opcode == 0x9) {
                    sendWsFrame(out, 0xA, payload);
                    continue;
                }
                if (opcode == 0xA) {
                    continue;
                }
                if (opcode == 0x0) {
                    if (fragmentOpcode == -1) continue;
                    fragmentOut.write(payload);
                    if (!fin) continue;
                    payload = fragmentOut.toByteArray();
                    opcode = fragmentOpcode;
                    fragmentOut.reset();
                    fragmentOpcode = -1;
                } else if (!fin) {
                    fragmentOpcode = opcode;
                    fragmentOut.reset();
                    fragmentOut.write(payload);
                    continue;
                }

                if (opcode == 0x1) {
                    String textMsg = new String(payload, StandardCharsets.UTF_8);
                    if (textMsg.contains("Path:turn.end")) {
                        break;
                    }
                } else if (opcode == 0x2) {
                    if (payload.length < 2) continue;
                    int headerLen = ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
                    if (2 + headerLen > payload.length) continue;
                    String header = new String(payload, 2, headerLen, StandardCharsets.UTF_8);
                    if (!header.contains("Path:audio")) continue;
                    int dataLen = payload.length - 2 - headerLen;
                    if (dataLen <= 0) continue;
                    if (audioOut.size() + dataLen > MAX_AUDIO_BYTES) {
                        throw new IOException("Audio response exceeds limit");
                    }
                    audioOut.write(payload, 2 + headerLen, dataLen);
                }
            }
            return audioOut.toByteArray();
        } finally {
            if (ssl != null) {
                try {
                    ssl.close();
                } catch (IOException ignored) {
                }
            }
            call.socket = null;
        }
    }

    private static void sendWsFrame(OutputStream out, int opcode, byte[] payload) throws IOException {
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);
        ByteArrayOutputStream frame = new ByteArrayOutputStream(14 + payload.length);
        frame.write(0x80 | (opcode & 0x0F));
        if (payload.length <= 125) {
            frame.write(0x80 | payload.length);
        } else if (payload.length <= 65535) {
            frame.write(0x80 | 126);
            frame.write((payload.length >>> 8) & 0xFF);
            frame.write(payload.length & 0xFF);
        } else {
            frame.write(0x80 | 127);
            byte[] lenBytes = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(payload.length).array();
            frame.write(lenBytes);
        }
        frame.write(mask);
        for (int i = 0; i < payload.length; i++) {
            frame.write(payload[i] ^ mask[i % 4]);
        }
        out.write(frame.toByteArray());
        out.flush();
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new EOFException("Unexpected EOF");
        return b;
    }

    private static byte[] readExact(InputStream in, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(data, offset, length - offset);
            if (n < 0) throw new EOFException("Unexpected EOF");
            offset += n;
        }
        return data;
    }

    private static String readAsciiLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int prev = -1;
        while (true) {
            int b = in.read();
            if (b < 0) {
                return line.size() == 0 ? null : line.toString(StandardCharsets.US_ASCII.name());
            }
            if (b == '\n') {
                byte[] bytes = line.toByteArray();
                int len = (prev == '\r' && bytes.length > 0) ? bytes.length - 1 : bytes.length;
                return new String(bytes, 0, len, StandardCharsets.US_ASCII);
            }
            line.write(b);
            prev = b;
        }
    }

    private static int parseHttpStatus(String statusLine) {
        String[] parts = statusLine.split(" ");
        if (parts.length < 2) return 0;
        try {
            return Integer.parseInt(parts[1]);
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private static String readStreamUtf8(InputStream input) throws IOException {
        if (input == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = input.read(buf)) != -1) {
            out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String normalizeVoiceName(String voice) {
        String trimmed = voice == null ? "" : voice.trim();
        if (trimmed.startsWith("Microsoft Server Speech Text to Speech Voice (")) {
            return trimmed;
        }
        Matcher matcher = SHORT_VOICE_PATTERN.matcher(trimmed);
        if (matcher.matches()) {
            String lang = matcher.group(1);
            String region = matcher.group(2);
            String name = matcher.group(3);
            int dash = name.indexOf('-');
            if (dash != -1) {
                region = region + "-" + name.substring(0, dash);
                name = name.substring(dash + 1);
            }
            return "Microsoft Server Speech Text to Speech Voice (" + lang + "-" + region + ", " + name + ")";
        }
        return trimmed.isEmpty()
            ? "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)"
            : trimmed;
    }

    private static String removeIncompatibleCharacters(String text) {
        StringBuilder sb = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if ((ch <= 8) || (ch >= 11 && ch <= 12) || (ch >= 14 && ch <= 31)) {
                sb.append(' ');
            } else {
                sb.append(ch);
            }
        }
        return sb.toString();
    }

    private static String escapeXml(String text) {
        StringBuilder sb = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            switch (ch) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                case '\'' -> sb.append("&apos;");
                default -> sb.append(ch);
            }
        }
        return sb.toString();
    }

    private static String connectId() {
        return UUID.randomUUID().toString().replace("-", "").toLowerCase(Locale.ROOT);
    }

    private static String messageOf(Throwable error) {
        String msg = error.getMessage();
        return (msg != null && !msg.isEmpty()) ? msg : error.getClass().getSimpleName();
    }

    private static void emitTtsAudio(String id, byte[] audio, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "audio");
            json.put("bytes", Base64.encodeToString(audio, Base64.NO_WRAP));
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitTtsError(String id, String message, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", "error");
            json.put("message", message);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitVoicesSuccess(String id, String text, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("ok", true);
            json.put("text", text);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitVoicesError(String id, String error, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("ok", false);
            json.put("error", error);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static String safeJson(JSONObject json) {
        return json.toString()
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029");
    }

    private static final class Http403SkewException extends Exception {
        final String dateHeader;

        Http403SkewException(String dateHeader) {
            this.dateHeader = dateHeader;
        }
    }

    private static final class ActiveCall {
        volatile boolean cancelled;
        volatile Socket socket;
        volatile HttpURLConnection httpConn;

        void cancel() {
            cancelled = true;
            Socket s = socket;
            if (s != null) {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
            }
            HttpURLConnection c = httpConn;
            if (c != null) {
                c.disconnect();
            }
        }
    }
}
