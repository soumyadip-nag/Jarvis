package com.ushnish.jarvis;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.io.File;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.List;

/**
 * Voice ID: whether a "Hey Jarvis" was said by the phone's owner. A free speaker model (WeSpeaker ResNet34, trained on
 * VoxCeleb; github.com/wenet-e2e/wespeaker) turns ~2 seconds of speech into a "voice print"; the owner's print is the
 * average of five "Hey Jarvis" recorded in Settings, and a new one matches if it's similar enough (cosine).
 * Everything happens on the phone: the audio and the print never leave it.
 * Plain Java, so it's tested off the phone against the same steps in Python (Kaldi-style 80-band fbank, mean removed).
 */
public final class SpeakerId implements AutoCloseable {

    public static final String MODEL = "wespeaker_en_voxceleb_resnet34.onnx";
    public static final String MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + MODEL;
    public static final int RATE = 16000;
    /** How much audio before the wake is checked. */
    public static final int CLIP = 2 * RATE;
    /** Default match thresholds: relaxed, normal, strict. Same voice scored 0.60+ in tests; other voices up to 0.46. */
    public static final float NORMAL = 0.5f;

    private static final int FRAME = 400;
    private static final int SHIFT = 160;
    private static final int FFT = 512;
    private static final int BINS = 80;
    private static final double[] WINDOW = new double[FRAME];
    private static final double[][] BANKS = new double[BINS][FFT / 2];
    private static final double LOG_FLOOR = Math.log(1.1920929e-7); // float epsilon, as Kaldi

    static {
        for (int i = 0; i < FRAME; i++) WINDOW[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)), 0.85);
        double low = mel(20), high = mel(RATE / 2.0);
        double delta = (high - low) / (BINS + 1);
        for (int b = 0; b < BINS; b++) {
            double left = low + b * delta, centre = left + delta, right = centre + delta;
            for (int k = 0; k < FFT / 2; k++) {
                double m = mel(k * (double) RATE / FFT);
                double up = (m - left) / (centre - left);
                double down = (right - m) / (right - centre);
                BANKS[b][k] = Math.max(0, Math.min(up, down));
            }
        }
    }

    private static double mel(double hz) {
        return 1127.0 * Math.log(1.0 + hz / 700.0);
    }

    private final OrtEnvironment env;
    private final OrtSession session;

    public SpeakerId(File model) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setIntraOpNumThreads(2);
        session = env.createSession(model.getPath(), options);
    }

    /** Kaldi-style log mel filterbank features (80 bands, 25 ms frames every 10 ms), with the mean of each band removed. */
    static float[][] features(short[] audio) {
        int frames = audio.length < FRAME ? 0 : 1 + (audio.length - FRAME) / SHIFT;
        float[][] out = new float[frames][BINS];
        double[] re = new double[FFT];
        double[] im = new double[FFT];
        double[] frame = new double[FRAME];
        for (int f = 0; f < frames; f++) {
            double mean = 0;
            for (int i = 0; i < FRAME; i++) {
                frame[i] = audio[f * SHIFT + i];
                mean += frame[i];
            }
            mean /= FRAME;
            for (int i = 0; i < FRAME; i++) frame[i] -= mean;
            for (int i = FRAME - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
            frame[0] -= 0.97 * frame[0];
            java.util.Arrays.fill(re, 0);
            java.util.Arrays.fill(im, 0);
            for (int i = 0; i < FRAME; i++) re[i] = frame[i] * WINDOW[i];
            fft(re, im);
            for (int b = 0; b < BINS; b++) {
                double energy = 0;
                for (int k = 0; k < FFT / 2; k++) {
                    if (BANKS[b][k] != 0) energy += BANKS[b][k] * (re[k] * re[k] + im[k] * im[k]);
                }
                out[f][b] = (float) (energy > 0 ? Math.max(Math.log(energy), LOG_FLOOR) : LOG_FLOOR);
            }
        }
        for (int b = 0; b < BINS && frames > 0; b++) {
            double mean = 0;
            for (int f = 0; f < frames; f++) mean += out[f][b];
            mean /= frames;
            for (int f = 0; f < frames; f++) out[f][b] -= (float) mean;
        }
        return out;
    }

    /** In-place radix-2 FFT. */
    private static void fft(double[] re, double[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double angle = -2 * Math.PI / len;
            double wr = Math.cos(angle), wi = Math.sin(angle);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k, b = i + k + len / 2;
                    double xr = re[b] * cr - im[b] * ci;
                    double xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    double next = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = next;
                }
            }
        }
    }

    /** The voice print of a clip: a unit-length vector. */
    public float[] print(short[] audio) throws OrtException {
        float[][] feats = features(audio);
        if (feats.length < 20) throw new IllegalArgumentException("too little audio");
        FloatBuffer buffer = FloatBuffer.allocate(feats.length * BINS);
        for (float[] row : feats) buffer.put(row);
        buffer.rewind();
        try (OnnxTensor input = OnnxTensor.createTensor(env, buffer, new long[] { 1, feats.length, BINS });
             OrtSession.Result out = session.run(Collections.singletonMap(session.getInputNames().iterator().next(), input))) {
            return unit(((float[][]) out.get(0).getValue())[0]);
        }
    }

    static float[] unit(float[] v) {
        double norm = 0;
        for (float x : v) norm += x * x;
        norm = Math.sqrt(norm);
        float[] out = new float[v.length];
        for (int i = 0; i < v.length; i++) out[i] = (float) (v[i] / (norm == 0 ? 1 : norm));
        return out;
    }

    static float similarity(float[] a, float[] b) {
        double dot = 0;
        for (int i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
        return (float) dot;
    }

    /** The owner's print: the average of their recordings, made unit length. */
    static float[] average(List<float[]> prints) {
        float[] sum = new float[prints.get(0).length];
        for (float[] p : prints) for (int i = 0; i < sum.length; i++) sum[i] += p[i];
        return unit(sum);
    }

    @Override
    public void close() throws OrtException {
        session.close();
    }
}
