package com.ushnish.jarvis;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;

/**
 * Listens for "Hey Jarvis" all the time, offline, so Jarvis answers even with the app closed or the phone locked.
 * Android only lets an app use the microphone in the background from a foreground service, which must show a
 * notification. While the app itself is listening to a request, this pauses and lets go of the microphone.
 */
public class WakeWordService extends Service {

    private static final String TAG = "JarvisWake";
    private static final String CHANNEL = "jarvis-wake";
    private static final String ALERT_CHANNEL = "jarvis-wake-alert";
    private static final String ACTION_STOP = "com.ushnish.jarvis.STOP_WAKE";
    private static final int NOTIFICATION = 2;
    private static final int WAKE_NOTIFICATION = 3;
    private static final long QUIET_AFTER_WAKE_MS = 2000;
    private static final long UNCLAIMED_WAKE_MS = 30_000;

    static volatile boolean running = false;
    static volatile boolean paused = false;
    static volatile boolean wakePending = false;
    static volatile String problem = null;
    static volatile boolean conversing = false;  // a hands-free conversation is going on
    static volatile long testUntil = 0;           // "Test my voice" in Settings: show scores, don't answer
    static volatile float bestHeard = 0;          // the highest score since the test started

    private Thread worker;

    public static void start(Context context) {
        android.content.Intent intent = new Intent(context, WakeWordService.class);
        androidx.core.content.ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, WakeWordService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION, listeningNotification("Say \"Hey Jarvis\""), type);
        } catch (RuntimeException e) {
            // Android refuses a microphone service started from the background (after a restart, for example).
            problem = "Android didn't allow listening in the background: open Jarvis once to start it.";
            Log.w(TAG, problem, e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (worker == null) {
            running = true;
            problem = null;
            worker = new Thread(this::listen, "jarvis-wake-word");
            worker.start();
        }
        return START_STICKY;
    }

    private void listen() {
        WakeWordDetector detector = null;
        AudioRecord record = null;
        long lastWake = 0;
        try {
            File models = new File(getFilesDir(), "wakeword");
            downloadModels(models);
            detector = new WakeWordDetector(models);
            short[] chunk = new short[WakeWordDetector.CHUNK];
            while (running) {
                // If nothing picked up a wake (the app was signed out, say), don't stay deaf: listen again.
                if (paused && wakePending && System.currentTimeMillis() - lastWake > UNCLAIMED_WAKE_MS) {
                    wakePending = false;
                    paused = false;
                }
                if (paused) {
                    if (record != null) {
                        record.stop();
                        record.release();
                        record = null;
                    }
                    Thread.sleep(150);
                    continue;
                }
                if (record == null) {
                    int size = Math.max(AudioRecord.getMinBufferSize(WakeWordDetector.RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT), WakeWordDetector.CHUNK * 2 * 4);
                    record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, WakeWordDetector.RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size);
                    record.startRecording();
                    detector.reset();
                }
                int read = 0;
                while (read < chunk.length && running && !paused) {
                    int n = record.read(chunk, read, chunk.length - read);
                    if (n < 0) throw new IllegalStateException("The microphone stopped (" + n + ")");
                    read += n;
                }
                if (read < chunk.length) continue;
                float score = detector.process(chunk);
                long now = System.currentTimeMillis();
                if (now < testUntil) {
                    bestHeard = Math.max(bestHeard, score);
                    continue;
                }
                if (score >= threshold() && now - lastWake > QUIET_AFTER_WAKE_MS) {
                    lastWake = now;
                    Log.i(TAG, "Hey Jarvis heard, score " + score);
                    if (MainActivity.visible || !HandsFree.ready(this)) {
                        woken("Tap to talk to Jarvis");
                        continue;
                    }
                    // Nobody's looking at the app: hold the whole conversation from here.
                    record.stop();
                    record.release();
                    record = null;
                    HandsFree.Outcome outcome = converse();
                    if (outcome == HandsFree.Outcome.SLEEP) {
                        stopSelf();
                        break;
                    }
                    if (outcome == HandsFree.Outcome.NEEDS_APP) woken("Tap to finish that in Jarvis");
                    paused = false;
                    wakePending = false;
                    lastWake = System.currentTimeMillis();
                }
            }
        } catch (InterruptedException ignored) {
            // stopping
        } catch (Exception e) {
            problem = "Listening for \"Hey Jarvis\" stopped: " + e.getMessage();
            Log.e(TAG, problem, e);
            stopSelf();
        } finally {
            if (record != null) {
                try { record.stop(); } catch (IllegalStateException ignored) { }
                record.release();
            }
            if (detector != null) {
                try { detector.close(); } catch (Exception ignored) { }
            }
        }
    }

    private HandsFree.Outcome converse() {
        conversing = true;
        try {
            return new HandsFree(this, this::showStatus).run();
        } finally {
            conversing = false;
            showStatus("Say \"Hey Jarvis\"");
        }
    }

    private void showStatus(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION, listeningNotification(text));
    }

    /** How sure the detector must be: the sensitivity chosen in Settings. */
    private float threshold() {
        return getSharedPreferences(HandsFree.PREFS, MODE_PRIVATE).getFloat("threshold", WakeWordDetector.THRESHOLD);
    }

    /** Opens Jarvis to listen. Without "Display over other apps", Android only allows a notification to do that. */
    private void woken(String text) {
        wakePending = true;
        paused = true; // the app takes the microphone now; it resumes this when the conversation ends
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("wake", true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
            try {
                startActivity(open);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "Couldn't open Jarvis directly", e);
            }
        }
        PendingIntent tap = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(ALERT_CHANNEL, "Hey Jarvis", NotificationManager.IMPORTANCE_HIGH));
        }
        Notification notification = new NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Yes, sir?")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setFullScreenIntent(tap, true)
            .build();
        manager.notify(WAKE_NOTIFICATION, notification);
        paused = false; // nothing took the microphone, so keep listening
    }

    private void downloadModels(File folder) throws Exception {
        folder.mkdirs();
        for (String name : WakeWordDetector.FILES) {
            File file = new File(folder, name);
            if (file.exists() && file.length() > 0) continue;
            getSystemService(NotificationManager.class).notify(NOTIFICATION, listeningNotification("Getting ready to listen…"));
            File partial = new File(folder, name + ".part");
            try (InputStream in = new URL(WakeWordDetector.MODELS_URL + name).openStream(); FileOutputStream out = new FileOutputStream(partial)) {
                byte[] buffer = new byte[65536];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
            if (!partial.renameTo(file)) throw new IllegalStateException("Couldn't save " + name);
        }
        getSystemService(NotificationManager.class).notify(NOTIFICATION, listeningNotification("Say \"Hey Jarvis\""));
    }

    private Notification listeningNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Listening for Hey Jarvis", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, WakeWordService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Jarvis is listening")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop listening", stop)
            .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        worker = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
