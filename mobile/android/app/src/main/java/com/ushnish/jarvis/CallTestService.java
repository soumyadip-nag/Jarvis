package com.ushnish.jarvis;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * An experiment: can Jarvis talk on a normal call through the speaker, and hear the reply through the mic?
 * Android has no supported way to put an app's audio into a call, so this measures what actually happens.
 * It runs as a foreground service because apps can't use the mic from the background otherwise.
 */
public class CallTestService extends Service {

    public interface Finished {
        void onFinished(JSObject result);
    }

    public static Finished finished;

    private static final String ACTION_START_SPEAKING = "com.ushnish.jarvis.START_SPEAKING";
    private static final String CHANNEL = "jarvis-call-test";
    private static final int SAMPLE_RATE = 16000;
    private static final long AUTO_START_MS = 25_000;
    private static final long LISTEN_AFTER_SPEECH_MS = 10_000;
    private static final long LONGEST_RECORDING_MS = 45_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicLong stopRecordingAt = new AtomicLong(0);
    private final JSObject result = new JSObject();
    private String message = "";
    private TextToSpeech tts;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_START_SPEAKING.equals(intent.getAction())) {
            begin();
            return START_NOT_STICKY;
        }
        if (intent != null) message = intent.getStringExtra("message");

        int types = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
        ServiceCompat.startForeground(this, 1, buildNotification(), types);
        handler.postDelayed(this::begin, AUTO_START_MS);
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Jarvis call test", NotificationManager.IMPORTANCE_HIGH));
        PendingIntent startSpeaking = PendingIntent.getService(
            this, 0,
            new Intent(this, CallTestService.class).setAction(ACTION_START_SPEAKING),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Jarvis call test")
            .setContentText("Tap when they answer. Jarvis starts by itself after 25 seconds.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(android.R.drawable.ic_btn_speak_now, "They answered: speak now", startSpeaking)
            .build();
    }

    /** Records throughout, so the result also shows whether the mic picked up Jarvis's own voice. */
    private void begin() {
        if (!started.compareAndSet(false, true)) return;
        handler.removeCallbacksAndMessages(null);

        AudioManager audio = getSystemService(AudioManager.class);
        try {
            audio.setSpeakerphoneOn(true);
            audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL), 0);
        } catch (Exception e) {
            result.put("speakerError", e.getMessage());
        }
        result.put("speakerOn", audio.isSpeakerphoneOn());
        result.put("audioMode", audio.getMode());

        stopRecordingAt.set(System.currentTimeMillis() + LONGEST_RECORDING_MS);
        new Thread(this::record).start();

        // If speech never starts or never reports finishing, still listen and finish.
        handler.postDelayed(this::speechEnded, 20_000);
        tts = new TextToSpeech(this, status -> {
            result.put("speechEngine", status == TextToSpeech.SUCCESS);
            if (status != TextToSpeech.SUCCESS) {
                speechEnded();
                return;
            }
            tts.setLanguage(Locale.UK);
            tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { result.put("speechStarted", true); }
                @Override public void onDone(String id) { speechEnded(); }
                @Override public void onError(String id) { result.put("speechError", true); speechEnded(); }
            });
            tts.speak(message, TextToSpeech.QUEUE_FLUSH, null, "jarvis-call-test");
        });
    }

    private void speechEnded() {
        handler.removeCallbacksAndMessages(null);
        stopRecordingAt.set(Math.min(stopRecordingAt.get(), System.currentTimeMillis() + LISTEN_AFTER_SPEECH_MS));
    }

    private void record() {
        int bufferSize = Math.max(AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), SAMPLE_RATE);
        AudioRecord recorder = null;
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        JSArray loudestPerSecond = new JSArray();
        try {
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("Recorder would not start");
            recorder.startRecording();
            result.put("recording", recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING);

            byte[] buffer = new byte[SAMPLE_RATE * 2]; // one second
            boolean checkedSilenced = false;
            while (System.currentTimeMillis() < stopRecordingAt.get()) {
                int offset = 0;
                while (offset < buffer.length) {
                    int read = recorder.read(buffer, offset, buffer.length - offset);
                    if (read <= 0) throw new IllegalStateException("Recorder read failed: " + read);
                    offset += read;
                }
                pcm.write(buffer, 0, offset);
                int loudest = 0;
                for (int i = 0; i + 1 < offset; i += 2) {
                    short sample = (short) ((buffer[i] & 0xff) | (buffer[i + 1] << 8));
                    loudest = Math.max(loudest, Math.abs((int) sample));
                }
                loudestPerSecond.put(loudest);
                if (!checkedSilenced && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    AudioRecordingConfiguration config = recorder.getActiveRecordingConfiguration();
                    if (config != null) result.put("silencedByAndroid", config.isClientSilenced());
                    checkedSilenced = true;
                }
            }
        } catch (Exception e) {
            result.put("recordError", e.getMessage());
        } finally {
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                recorder.release();
            }
        }
        result.put("loudestPerSecond", loudestPerSecond);
        if (pcm.size() > 0) result.put("wav", Base64.encodeToString(wav(pcm.toByteArray()), Base64.NO_WRAP));
        handler.post(this::finish);
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer out = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes()).putInt(36 + pcm.length).put("WAVE".getBytes());
        out.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1);
        out.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort((short) 2).putShort((short) 16);
        out.put("data".getBytes()).putInt(pcm.length).put(pcm);
        return out.array();
    }

    private void finish() {
        if (tts != null) tts.shutdown();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        if (finished != null) {
            finished.onFinished(result);
            finished = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
