package io.github.lijiahua1024.dsreplica;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class StreamKeepAliveService extends Service {
    static final String CHANNEL_ONGOING = "stream_ongoing";
    static final String CHANNEL_ALERTS = "stream_alerts";
    static final int ONGOING_NOTIFICATION_ID = 1001;
    private static final int STOP_ACTION_REQUEST_CODE = 1002;
    private static final int ALERT_ID_BASE = 2000;
    private static final int ALERT_ID_SPAN = 100_000;
    static final String ACTION_STOP_STREAM = "io.github.lijiahua1024.dsreplica.action.STOP_STREAM";
    static final String EXTRA_SESSION_ID = "extra_session_id";
    private static final String WAKELOCK_TAG = "Elsewhere:StreamKeepAlive";
    private static final long WAKELOCK_TIMEOUT_MS = 15 * 60 * 1000L;

    private static StreamKeepAliveService activeInstance;
    private static boolean running;
    private static boolean pendingStart;
    private static boolean shouldRun;
    private static String latestSessionsJson = "[]";
    private static boolean latestZh = true;
    private static Consumer<String> stopListener;

    private PowerManager.WakeLock wakeLock;

    static void setStopListener(Consumer<String> listener) {
        stopListener = listener;
    }

    static void ensureChannels(Context context, boolean zh) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel ongoing = new NotificationChannel(
            CHANNEL_ONGOING,
            zh ? "回复进行中" : "Ongoing replies",
            NotificationManager.IMPORTANCE_LOW
        );
        ongoing.setShowBadge(false);
        ongoing.setSound(null, null);
        ongoing.enableVibration(false);
        ongoing.enableLights(false);
        manager.createNotificationChannel(ongoing);

        NotificationChannel alerts = new NotificationChannel(
            CHANNEL_ALERTS,
            zh ? "后台回复提醒" : "Background reply alerts",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        manager.createNotificationChannel(alerts);
    }

    static void sync(Context context, boolean enabled, String sessionsJson, int activeCount, boolean zh) {
        latestZh = zh;
        if (enabled && activeCount > 0) {
            latestSessionsJson = sessionsJson != null ? sessionsJson : "[]";
            shouldRun = true;
            if (running && activeInstance != null) {
                activeInstance.updateOngoingNotification();
                activeInstance.acquireOrRefreshWakeLock();
            } else if (!pendingStart) {
                pendingStart = true;
                try {
                    context.startForegroundService(new Intent(context, StreamKeepAliveService.class));
                } catch (IllegalStateException | SecurityException ignored) {
                    pendingStart = false;
                }
            }
            return;
        }

        shouldRun = false;
        latestSessionsJson = "[]";
        if (running && activeInstance != null) {
            activeInstance.stopNow();
        }
        // When pendingStart is true, wait for onStartCommand to call startForeground before stopping
        // so Android 12+ does not throw ForegroundServiceDidNotStartInTimeException.
    }

    static void stopIfRunning(Context context) {
        shouldRun = false;
        latestSessionsJson = "[]";
        if (activeInstance != null) {
            activeInstance.stopNow();
        } else if (!pendingStart) {
            context.stopService(new Intent(context, StreamKeepAliveService.class));
        }
    }

    static int alertNotificationId(String sessionId) {
        return ALERT_ID_BASE + ((sessionId.hashCode() & 0x7fffffff) % ALERT_ID_SPAN);
    }

    static void showBackgroundAlert(Context context, String payloadJson) {
        if (payloadJson == null || payloadJson.isEmpty()) return;
        try {
            JSONObject payload = new JSONObject(payloadJson);
            String sessionId = payload.optString("sessionId", "").trim();
            if (sessionId.isEmpty()) return;
            String title = payload.optString("title", "").trim();
            String kind = payload.optString("kind", "").trim();
            String detail = payload.optString("detail", "").trim();
            String locale = payload.optString("locale", "");
            boolean zh = locale.isEmpty() || locale.startsWith("zh");

            String body;
            if ("done".equals(kind)) {
                body = zh ? "回复已完成" : "Reply completed";
            } else if ("error".equals(kind)) {
                body = zh ? "回复生成失败" : "Reply failed";
            } else if ("awaiting_confirmation".equals(kind)) {
                if (!detail.isEmpty()) {
                    body = zh ? "等待确认 · " + detail : "Waiting for confirmation · " + detail;
                } else {
                    body = zh ? "等待确认调用工具" : "Waiting to confirm tool call";
                }
            } else {
                return;
            }

            ensureChannels(context, zh);
            int notificationId = alertNotificationId(sessionId);
            Intent openIntent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_SESSION_ID, sessionId);
            PendingIntent contentPending = PendingIntent.getActivity(
                context,
                notificationId,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new Notification.Builder(context, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_elsewhere)
                .setContentTitle(title.isEmpty() ? "Elsewhere" : title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(contentPending)
                .build();

            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(notificationId, notification);
            }
        } catch (JSONException ignored) {
        }
    }

    static void clearSessionNotification(Context context, String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(alertNotificationId(sessionId));
        }
    }

    private static void dispatchStop(String sessionId) {
        Consumer<String> listener = stopListener;
        if (listener != null) {
            listener.accept(sessionId);
        } else if (activeInstance != null) {
            shouldRun = false;
            activeInstance.stopNow();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP_STREAM.equals(intent.getAction())) {
            String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
            dispatchStop(sessionId);
            if (!running) {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        pendingStart = false;
        activeInstance = this;
        running = true;
        ensureChannels(this, latestZh);
        Notification notification = buildOngoingNotification(this, latestSessionsJson, latestZh);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                ONGOING_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(ONGOING_NOTIFICATION_ID, notification);
        }

        if (!shouldRun) {
            stopNow();
            return START_NOT_STICKY;
        }

        acquireOrRefreshWakeLock();
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        shouldRun = false;
        dispatchStop(null);
        stopNow();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        running = false;
        pendingStart = false;
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.onDestroy();
    }

    private void updateOngoingNotification() {
        ensureChannels(this, latestZh);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(
                ONGOING_NOTIFICATION_ID,
                buildOngoingNotification(this, latestSessionsJson, latestZh)
            );
        }
    }

    private void acquireOrRefreshWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null) {
            wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException ignored) {
            }
        }
    }

    private void stopNow() {
        releaseWakeLock();
        running = false;
        if (activeInstance == this) {
            activeInstance = null;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static Notification buildOngoingNotification(Context context, String sessionsJson, boolean zh) {
        JSONArray sessions;
        try {
            sessions = new JSONArray(sessionsJson);
        } catch (JSONException ignored) {
            sessions = new JSONArray();
        }

        int count = sessions.length();
        String title = "Elsewhere";
        String text = zh ? "正在回复…" : "Replying…";
        String openSessionId = null;
        String stopSessionId = null;
        String stopLabel = zh ? "全部停止" : "Stop all";

        if (count == 1) {
            JSONObject first = sessions.optJSONObject(0);
            String sessionId = first != null ? first.optString("sessionId", "").trim() : "";
            String sessionTitle = first != null ? first.optString("title", "").trim() : "";
            String phase = first != null ? first.optString("phase", "streaming") : "streaming";
            String detail = first != null ? first.optString("detail", "").trim() : "";

            title = sessionTitle.isEmpty() ? "Elsewhere" : sessionTitle;
            text = formatSinglePhaseText(phase, detail, zh);
            openSessionId = sessionId.isEmpty() ? null : sessionId;
            stopSessionId = openSessionId;
            stopLabel = zh ? "停止" : "Stop";
        } else if (count >= 2) {
            int awaitingCount = 0;
            String awaitingSessionId = null;
            for (int i = 0; i < count; i++) {
                JSONObject item = sessions.optJSONObject(i);
                if (item != null && "awaiting_confirmation".equals(item.optString("phase", ""))) {
                    awaitingCount++;
                    if (awaitingCount == 1) {
                        String candidate = item.optString("sessionId", "").trim();
                        if (!candidate.isEmpty()) {
                            awaitingSessionId = candidate;
                        }
                    }
                }
            }
            if (awaitingCount > 0) {
                text = zh
                    ? "正在回复 " + count + " 个对话（含等待确认）"
                    : "Replying to " + count + " chats (confirmation needed)";
            } else {
                text = zh
                    ? "正在回复 " + count + " 个对话"
                    : "Replying to " + count + " chats";
            }
            if (awaitingCount == 1) {
                openSessionId = awaitingSessionId;
            }
        }

        Intent openIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (openSessionId != null) {
            openIntent.putExtra(EXTRA_SESSION_ID, openSessionId);
        }
        PendingIntent contentPending = PendingIntent.getActivity(
            context,
            ONGOING_NOTIFICATION_ID,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(context, StreamKeepAliveService.class)
            .setAction(ACTION_STOP_STREAM);
        if (stopSessionId != null) {
            stopIntent.putExtra(EXTRA_SESSION_ID, stopSessionId);
        }
        PendingIntent stopPending = PendingIntent.getService(
            context,
            STOP_ACTION_REQUEST_CODE,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Action stopAction = new Notification.Action.Builder(null, stopLabel, stopPending)
            .build();

        Notification.Builder builder = new Notification.Builder(context, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_elsewhere)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentPending)
            .addAction(stopAction);

        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private static String formatSinglePhaseText(String phase, String detail, boolean zh) {
        if ("awaiting_confirmation".equals(phase)) {
            if (!detail.isEmpty()) {
                return zh ? "等待工具确认 · " + detail : "Waiting for confirmation · " + detail;
            }
            return zh ? "等待工具确认…" : "Waiting for confirmation…";
        }
        if ("tool".equals(phase)) {
            if (!detail.isEmpty()) {
                return zh ? "正在调用工具 · " + detail : "Using tool · " + detail;
            }
            return zh ? "正在调用工具…" : "Using tool…";
        }
        return zh ? "正在回复…" : "Replying…";
    }
}
