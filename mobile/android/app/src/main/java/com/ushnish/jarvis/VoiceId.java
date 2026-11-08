package com.ushnish.jarvis;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * Voice ID on the phone: the owner records five "Hey Jarvis" in Settings, and every wake is then checked against
 * their voice print. Not the owner: Jarvis still answers, but nothing personal (the server's guest mode). It's a
 * filter, not a key: a locked phone stays locked to personal things whatever the voice, as a recording could fool it.
 * The wake-word thread owns an instance (the last two seconds of audio, the model); the static fields are for the app.
 */
final class VoiceId {

    private static final String TAG = "JarvisVoiceId";
    static final int SAMPLES = 5;
    /** Each recording must sound like the others, or the print would be poor. */
    private static final float CONSISTENT = 0.5f;

    // For the app: setup progress, and the last wake's result.
    static volatile boolean setupActive = false;
    static volatile int collected = 0;
    static volatile String setupProblem = null;
    static volatile boolean modelReady = false;
    /** Whether the last "Hey Jarvis" was the owner: null when voice ID isn't set up (everyone is trusted as before). */
    static volatile Boolean lastWakeOwner = null;
    static volatile float lastScore = -1;
    /** "Test my voice": the voice score at the best wake score. */
    static volatile float testScore = -1;

    private static final List<float[]> pending = new ArrayList<>();

    private final short[] ring = new short[SpeakerId.CLIP];
    private int at = 0;
    private boolean full = false;
    private SpeakerId model;

    // ───────── setup, started from Settings ─────────

    static File modelFile(Context context) {
        return new File(new File(context.getFilesDir(), "speaker"), SpeakerId.MODEL);
    }

    static boolean enrolled(Context context) {
        return prefs(context).getString("voicePrint", null) != null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(HandsFree.PREFS, Context.MODE_PRIVATE);
    }

    /** Fetches the model if needed, then collects the next five wakes as recordings. */
    static void beginSetup(Context context) {
        synchronized (pending) { pending.clear(); }
        collected = 0;
        setupProblem = null;
        setupActive = false;
        new Thread(() -> {
            try {
                download(context);
                modelReady = true;
                setupActive = true;
            } catch (Exception e) {
                setupProblem = "Couldn't get the voice model: " + e.getMessage();
                Log.e(TAG, setupProblem, e);
            }
        }, "jarvis-voice-model").start();
    }

    static void cancelSetup() {
        setupActive = false;
        synchronized (pending) { pending.clear(); }
    }

    static void remove(Context context) {
        cancelSetup();
        prefs(context).edit().remove("voicePrint").apply();
        lastWakeOwner = null;
    }

    private static void download(Context context) throws Exception {
        File file = modelFile(context);
        if (file.exists() && file.length() > 1_000_000) return;
        file.getParentFile().mkdirs();
        File partial = new File(file.getPath() + ".part");
        try (InputStream in = new URL(SpeakerId.MODEL_URL).openStream(); FileOutputStream out = new FileOutputStream(partial)) {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
        if (!partial.renameTo(file)) throw new IllegalStateException("couldn't save it");
    }

    // ───────── on the wake-word thread ─────────

    /** Keeps the last two seconds of audio. */
    void add(short[] chunk) {
        for (short s : chunk) {
            ring[at++] = s;
            if (at == ring.length) {
                at = 0;
                full = true;
            }
        }
    }

    private short[] clip() {
        short[] out = new short[full ? ring.length : at];
        if (full) {
            System.arraycopy(ring, at, out, 0, ring.length - at);
            System.arraycopy(ring, 0, out, ring.length - at, at);
        } else {
            System.arraycopy(ring, 0, out, 0, at);
        }
        return out;
    }

    private SpeakerId model(Context context) throws Exception {
        if (model == null) {
            File file = modelFile(context);
            if (!file.exists()) return null;
            model = new SpeakerId(file);
            modelReady = true;
        }
        return model;
    }

    /** During setup: one more recording. Returns true when it was used. */
    boolean collect(Context context) {
        try {
            SpeakerId id = model(context);
            if (id == null) return false;
            float[] print = id.print(clip());
            List<float[]> all;
            synchronized (pending) {
                pending.add(print);
                collected = pending.size();
                if (pending.size() < SAMPLES) return true;
                all = new ArrayList<>(pending);
                pending.clear();
            }
            setupActive = false;
            float[] owner = SpeakerId.average(all);
            float worst = 1;
            for (float[] p : all) worst = Math.min(worst, SpeakerId.similarity(owner, p));
            Log.i(TAG, "setup: least alike recording " + worst);
            if (worst < CONSISTENT) {
                setupProblem = "Those didn't sound alike enough. Try again somewhere quiet, saying it the way you normally would.";
                collected = 0;
                return true;
            }
            StringBuilder text = new StringBuilder();
            for (float v : owner) text.append(text.length() == 0 ? "" : ",").append(v);
            prefs(context).edit().putString("voicePrint", text.toString()).apply();
            return true;
        } catch (Exception e) {
            setupProblem = "Setting up your voice failed: " + e.getMessage();
            setupActive = false;
            Log.e(TAG, setupProblem, e);
            return true;
        }
    }

    /** How much the last two seconds sound like the owner, or null if voice ID isn't set up. */
    Float score(Context context) {
        String saved = prefs(context).getString("voicePrint", null);
        if (saved == null) return null;
        try {
            SpeakerId id = model(context);
            if (id == null) return -1f; // set up, but the model is missing: not trusted
            String[] parts = saved.split(",");
            float[] owner = new float[parts.length];
            for (int i = 0; i < parts.length; i++) owner[i] = Float.parseFloat(parts[i]);
            return SpeakerId.similarity(owner, id.print(clip()));
        } catch (Exception e) {
            Log.e(TAG, "voice check failed", e);
            return -1f;
        }
    }

    /** Checks a wake and records the result for the conversation and the app. */
    void checkWake(Context context) {
        Float s = score(context);
        lastScore = s == null ? -1 : s;
        lastWakeOwner = s == null ? null : s >= prefs(context).getFloat("voiceThreshold", SpeakerId.NORMAL);
        Log.i(TAG, "wake voice score " + lastScore + " owner " + lastWakeOwner);
    }

    void close() {
        if (model != null) {
            try { model.close(); } catch (Exception ignored) { }
            model = null;
        }
    }
}
