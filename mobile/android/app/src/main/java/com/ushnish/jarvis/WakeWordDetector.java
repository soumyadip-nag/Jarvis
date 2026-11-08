package com.ushnish.jarvis;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.io.File;
import java.nio.FloatBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Random;

/**
 * Hears "Hey Jarvis", offline, with openWakeWord's free models (github.com/dscripka/openWakeWord; the models are
 * for non-commercial use). The same steps as the laptop's Backend/WakeWord.py, so the two should change together:
 * 80 ms of 16 kHz audio becomes mel spectrogram frames, every 76 frames a speech embedding, and the last
 * 16 embeddings a score from 0 to 1. Plain Java, so it can be tested off the phone too.
 */
public final class WakeWordDetector implements AutoCloseable {

    public static final int RATE = 16000;
    public static final int CHUNK = 1280;
    /** The default ("normal" sensitivity). Ordinary speech scores under 0.1; accented "Hey Jarvis" can be 0.4 to 0.7. */
    public static final float THRESHOLD = 0.35f;
    public static final String[] FILES = { "melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx" };
    public static final String MODELS_URL = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/";

    private static final int MEL_BINS = 32;
    private static final int WINDOW = 76;
    private static final int FEATURES = 16;
    private static final int RECENT = CHUNK + 160 * 3;

    private final OrtEnvironment env;
    private final OrtSession mel;
    private final OrtSession embed;
    private final OrtSession wake;

    private final float[] recent = new float[RECENT];
    private int recentLength = 0;
    private final ArrayDeque<float[]> mels = new ArrayDeque<>();
    private final ArrayDeque<float[]> features = new ArrayDeque<>();
    private int warmup;

    public WakeWordDetector(File folder) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setIntraOpNumThreads(1); // it runs all day, so stay light
        options.setInterOpNumThreads(1);
        mel = env.createSession(new File(folder, FILES[0]).getPath(), options);
        embed = env.createSession(new File(folder, FILES[1]).getPath(), options);
        wake = env.createSession(new File(folder, FILES[2]).getPath(), options);
        reset();
    }

    /** Starts afresh, as after a pause, so old audio can't trigger it. */
    public void reset() throws OrtException {
        recentLength = 0;
        mels.clear();
        for (int i = 0; i < WINDOW; i++) {
            float[] row = new float[MEL_BINS];
            java.util.Arrays.fill(row, 1f);
            mels.add(row);
        }
        features.clear();
        Random random = new Random(0);
        float[] noise = new float[RATE * 4];
        for (int i = 0; i < noise.length; i++) noise[i] = random.nextInt(2000) - 1000;
        features.addAll(embeddingsOf(noise));
        warmup = 5;
    }

    /** `chunk` is 1280 samples of 16-bit audio. Returns how sure it is that "Hey Jarvis" was just said. */
    public float process(short[] chunk) throws OrtException {
        // The last 1280 + 480 samples, as openWakeWord uses.
        int keep = Math.min(recentLength, RECENT - chunk.length);
        System.arraycopy(recent, recentLength - keep, recent, 0, keep);
        for (int i = 0; i < chunk.length; i++) recent[keep + i] = chunk[i];
        recentLength = keep + chunk.length;

        float[][] frames = melFrames(recent, recentLength);
        Collections.addAll(mels, frames);
        while (mels.size() > 970) mels.removeFirst();

        float[] window = new float[WINDOW * MEL_BINS];
        Iterator<float[]> rows = mels.descendingIterator();
        for (int r = WINDOW - 1; r >= 0; r--) System.arraycopy(rows.next(), 0, window, r * MEL_BINS, MEL_BINS);
        features.add(embed(window, 1).get(0));
        while (features.size() > 120) features.removeFirst();

        float[] last = new float[FEATURES * 96];
        Iterator<float[]> feats = features.descendingIterator();
        for (int r = FEATURES - 1; r >= 0; r--) System.arraycopy(feats.next(), 0, last, r * 96, 96);
        float score;
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(last), new long[] { 1, FEATURES, 96 });
             OrtSession.Result out = wake.run(Collections.singletonMap(wake.getInputNames().iterator().next(), input))) {
            score = ((float[][]) out.get(0).getValue())[0][0];
        }
        if (warmup > 0) {
            warmup--;
            return 0f;
        }
        return score;
    }

    private float[][] melFrames(float[] samples, int length) throws OrtException {
        float[] audio = java.util.Arrays.copyOf(samples, length);
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(audio), new long[] { 1, length });
             OrtSession.Result out = mel.run(Collections.singletonMap(mel.getInputNames().iterator().next(), input))) {
            float[][] frames = ((float[][][][]) out.get(0).getValue())[0][0];
            for (float[] frame : frames) for (int i = 0; i < frame.length; i++) frame[i] = frame[i] / 10f + 2f;
            return frames;
        }
    }

    private List<float[]> embeddingsOf(float[] samples) throws OrtException {
        float[][] frames = melFrames(samples, samples.length);
        int windows = 0;
        for (int i = 0; i < frames.length - WINDOW; i += 8) windows++;
        float[] batch = new float[windows * WINDOW * MEL_BINS];
        int w = 0;
        for (int i = 0; i < frames.length - WINDOW; i += 8, w++) {
            for (int r = 0; r < WINDOW; r++) System.arraycopy(frames[i + r], 0, batch, (w * WINDOW + r) * MEL_BINS, MEL_BINS);
        }
        return embed(batch, windows);
    }

    private List<float[]> embed(float[] windows, int count) throws OrtException {
        List<float[]> out = new ArrayList<>();
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(windows), new long[] { count, WINDOW, MEL_BINS, 1 });
             OrtSession.Result result = embed.run(Collections.singletonMap(embed.getInputNames().iterator().next(), input))) {
            float[][][][] values = (float[][][][]) result.get(0).getValue();
            for (float[][][] v : values) out.add(v[0][0]);
        }
        return out;
    }

    @Override
    public void close() throws OrtException {
        mel.close();
        embed.close();
        wake.close();
    }
}
