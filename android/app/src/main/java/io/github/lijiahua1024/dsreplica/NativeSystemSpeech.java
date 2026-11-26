package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Encapsulates Android system TextToSpeech and SpeechRecognizer for offline/zero-key
 * synthesis and recognition, including third-party TTS engines such as MultiTTS.
 */
final class NativeSystemSpeech {
    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object ttsLock = new Object();
    private final List<Runnable> pendingTtsActions = new ArrayList<>();

    private TextToSpeech tts;
    private boolean ttsInitializing;
    private boolean ttsReady;
    private boolean ttsFailed;
    private Consumer<String> activeTtsEmit;

    private SpeechRecognizer recognizer;
    private Consumer<String> activeAsrEmit;
    private volatile double asrLevel;
    private volatile boolean destroyed;

    NativeSystemSpeech(Context context) {
        this.appContext = context.getApplicationContext();
    }

    void listVoices(String requestId, Consumer<String> emit) {
        if (requestId == null || requestId.isEmpty() || emit == null || destroyed) return;
        withReadyTts(() -> {
            if (destroyed) return;
            try {
                if (ttsFailed || tts == null) {
                    emitVoicesError(requestId, "System TTS engine unavailable", emit);
                    return;
                }
                Set<Voice> voices = tts.getVoices();
                JSONArray array = new JSONArray();
                if (voices != null) {
                    for (Voice v : voices) {
                        if (v == null || v.getName() == null) continue;
                        Set<String> features = v.getFeatures();
                        if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) {
                            continue;
                        }
                        JSONObject item = new JSONObject();
                        item.put("id", v.getName());
                        item.put("name", v.getName());
                        Locale locale = v.getLocale();
                        item.put("locale", locale != null ? locale.toLanguageTag() : "");
                        item.put("network", v.isNetworkConnectionRequired());
                        array.put(item);
                    }
                }
                JSONObject res = new JSONObject();
                res.put("id", requestId);
                res.put("ok", true);
                res.put("voices", array);
                emit.accept(safeJson(res));
            } catch (RuntimeException | JSONException error) {
                emitVoicesError(requestId, messageOf(error), emit);
            }
        });
    }

    void speak(String utteranceId, String text, String voiceId, float rate, Consumer<String> emit) {
        if (utteranceId == null || utteranceId.isEmpty() || text == null || emit == null || destroyed) {
            return;
        }
        withReadyTts(() -> {
            if (destroyed) return;
            if (ttsFailed || tts == null) {
                emitTtsEvent(utteranceId, "error", "System TTS engine unavailable", emit);
                return;
            }
            activeTtsEmit = emit;
            try {
                if (voiceId != null && !voiceId.isEmpty()) {
                    Set<Voice> voices = tts.getVoices();
                    if (voices != null) {
                        for (Voice v : voices) {
                            if (v != null && voiceId.equals(v.getName())) {
                                tts.setVoice(v);
                                break;
                            }
                        }
                    }
                } else {
                    Voice def = tts.getDefaultVoice();
                    if (def != null) {
                        tts.setVoice(def);
                    }
                }
                float clampedRate = Math.max(0.5f, Math.min(2.5f, rate));
                tts.setSpeechRate(clampedRate);
                int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
                if (result != TextToSpeech.SUCCESS) {
                    emitTtsEvent(utteranceId, "error", "System TTS speak failed", emit);
                }
            } catch (RuntimeException error) {
                emitTtsEvent(utteranceId, "error", messageOf(error), emit);
            }
        });
    }

    void stopTts() {
        synchronized (ttsLock) {
            pendingTtsActions.clear();
            if (tts != null && ttsReady) {
                try {
                    tts.stop();
                } catch (RuntimeException ignored) {
                }
            }
        }
    }

    boolean isAsrAvailable() {
        try {
            return SpeechRecognizer.isRecognitionAvailable(appContext);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    void startAsr(String langTag, Consumer<String> emit) {
        if (emit == null || destroyed) return;
        mainHandler.post(() -> {
            if (destroyed) return;
            destroyRecognizerLocked();
            if (!isAsrAvailable()) {
                emitAsrError(SpeechRecognizer.ERROR_CLIENT, "unavailable", emit);
                return;
            }
            activeAsrEmit = emit;
            asrLevel = 0;
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(appContext);
                recognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onReadyForSpeech(Bundle params) {
                        emitAsrSimple("ready", emit);
                    }

                    @Override
                    public void onBeginningOfSpeech() {}

                    @Override
                    public void onRmsChanged(float rmsdB) {
                        double normalized = Math.max(0.0, Math.min(1.0, (rmsdB + 2.0) / 10.0));
                        asrLevel = normalized;
                        emitAsrRms(normalized, emit);
                    }

                    @Override
                    public void onBufferReceived(byte[] buffer) {}

                    @Override
                    public void onEndOfSpeech() {
                        asrLevel = 0;
                        emitAsrSimple("end", emit);
                    }

                    @Override
                    public void onError(int error) {
                        asrLevel = 0;
                        String kind = switch (error) {
                            case SpeechRecognizer.ERROR_NO_MATCH,
                                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "empty";
                            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied";
                            case SpeechRecognizer.ERROR_NETWORK,
                                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network";
                            default -> "error";
                        };
                        emitAsrError(error, kind, emit);
                        destroyRecognizerLocked();
                    }

                    @Override
                    public void onResults(Bundle results) {
                        asrLevel = 0;
                        String text = extractText(results);
                        emitAsrText("result", text, emit);
                        destroyRecognizerLocked();
                    }

                    @Override
                    public void onPartialResults(Bundle partialResults) {
                        String text = extractText(partialResults);
                        if (!text.isEmpty()) {
                            emitAsrText("partial", text, emit);
                        }
                    }

                    @Override
                    public void onEvent(int eventType, Bundle params) {}
                });

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.getPackageName());
                if (langTag != null && !langTag.trim().isEmpty()) {
                    String tag = langTag.trim();
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, tag);
                }
                recognizer.startListening(intent);
            } catch (RuntimeException error) {
                asrLevel = 0;
                emitAsrError(-1, "error", emit);
                destroyRecognizerLocked();
            }
        });
    }

    void stopAsr() {
        mainHandler.post(() -> {
            asrLevel = 0;
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (RuntimeException ignored) {
                }
            }
        });
    }

    void cancelAsr() {
        asrLevel = 0;
        mainHandler.post(() -> {
            activeAsrEmit = null;
            if (recognizer != null) {
                try {
                    recognizer.cancel();
                } catch (RuntimeException ignored) {
                }
                destroyRecognizerLocked();
            }
        });
    }

    double getAsrLevel() {
        return asrLevel;
    }

    void destroy() {
        destroyed = true;
        synchronized (ttsLock) {
            pendingTtsActions.clear();
            activeTtsEmit = null;
            if (tts != null) {
                try {
                    tts.stop();
                    tts.shutdown();
                } catch (RuntimeException ignored) {
                }
                tts = null;
            }
            ttsReady = false;
            ttsInitializing = false;
        }
        mainHandler.post(this::destroyRecognizerLocked);
    }

    private void destroyRecognizerLocked() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (RuntimeException ignored) {
            }
            recognizer = null;
        }
    }

    private void withReadyTts(Runnable action) {
        synchronized (ttsLock) {
            if (destroyed) return;
            if (ttsReady || ttsFailed) {
                new Thread(action, "SystemTtsAction").start();
                return;
            }
            pendingTtsActions.add(action);
            if (ttsInitializing) {
                return;
            }
            ttsInitializing = true;
        }
        tts = new TextToSpeech(appContext, status -> {
            List<Runnable> queued;
            synchronized (ttsLock) {
                ttsInitializing = false;
                if (destroyed) {
                    if (tts != null) {
                        try {
                            tts.shutdown();
                        } catch (RuntimeException ignored) {
                        }
                        tts = null;
                    }
                    pendingTtsActions.clear();
                    return;
                }
                if (status == TextToSpeech.SUCCESS && tts != null) {
                    ttsReady = true;
                    ttsFailed = false;
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            Consumer<String> emit = activeTtsEmit;
                            if (emit != null) emitTtsEvent(utteranceId, "start", null, emit);
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            Consumer<String> emit = activeTtsEmit;
                            if (emit != null) emitTtsEvent(utteranceId, "done", null, emit);
                        }

                        @Override
                        @Deprecated
                        public void onError(String utteranceId) {
                            Consumer<String> emit = activeTtsEmit;
                            if (emit != null) emitTtsEvent(utteranceId, "error", "System TTS playback error", emit);
                        }

                        @Override
                        public void onError(String utteranceId, int errorCode) {
                            Consumer<String> emit = activeTtsEmit;
                            if (emit != null) {
                                emitTtsEvent(utteranceId, "error", "System TTS error " + errorCode, emit);
                            }
                        }

                        @Override
                        public void onStop(String utteranceId, boolean interrupted) {
                            Consumer<String> emit = activeTtsEmit;
                            if (emit != null) emitTtsEvent(utteranceId, "done", null, emit);
                        }
                    });
                } else {
                    ttsFailed = true;
                }
                queued = new ArrayList<>(pendingTtsActions);
                pendingTtsActions.clear();
            }
            for (Runnable task : queued) {
                new Thread(task, "SystemTtsAction").start();
            }
        });
    }

    private static String extractText(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return "";
        String first = matches.get(0);
        return first == null ? "" : first;
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

    private static void emitTtsEvent(String id, String type, String message, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("type", type);
            if (message != null) json.put("message", message);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitAsrSimple(String type, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", type);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitAsrRms(double level, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "rms");
            json.put("level", level);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitAsrText(String type, String text, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", type);
            json.put("text", text != null ? text : "");
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static void emitAsrError(int code, String kind, Consumer<String> emit) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "error");
            json.put("code", code);
            json.put("kind", kind);
            emit.accept(safeJson(json));
        } catch (JSONException ignored) {
        }
    }

    private static String messageOf(Throwable error) {
        String msg = error.getMessage();
        return (msg != null && !msg.isEmpty()) ? msg : error.getClass().getSimpleName();
    }

    private static String safeJson(JSONObject json) {
        return json.toString()
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029");
    }
}
