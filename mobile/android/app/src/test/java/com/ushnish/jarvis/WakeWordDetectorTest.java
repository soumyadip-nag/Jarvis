package com.ushnish.jarvis;

import static org.junit.Assert.assertTrue;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * The phone's detector, run on recordings whose scores from the laptop's detector (Backend/WakeWord.py) are known:
 * "Hey Jarvis" scored 0.993 in a British voice and 0.698 in an Indian one, and an ordinary sentence 0.083.
 */
public class WakeWordDetectorTest {

    private static File models;

    @BeforeClass
    public static void downloadModels() throws Exception {
        models = new File("build/wakeword-models");
        models.mkdirs();
        for (String name : WakeWordDetector.FILES) {
            File file = new File(models, name);
            if (file.exists()) continue;
            try (InputStream in = new URL(WakeWordDetector.MODELS_URL + name).openStream(); FileOutputStream out = new FileOutputStream(file)) {
                in.transferTo(out);
            }
        }
    }

    /** The highest score while listening to a 16 kHz mono WAV from the test resources. */
    private static float bestScore(String name) throws Exception {
        byte[] bytes;
        try (InputStream in = WakeWordDetectorTest.class.getClassLoader().getResourceAsStream(name)) {
            bytes = new DataInputStream(in).readAllBytes();
        }
        ByteBuffer data = ByteBuffer.wrap(bytes, 44, bytes.length - 44).order(ByteOrder.LITTLE_ENDIAN);
        short[] samples = new short[data.remaining() / 2];
        data.asShortBuffer().get(samples);
        float best = 0;
        try (WakeWordDetector detector = new WakeWordDetector(models)) {
            short[] chunk = new short[WakeWordDetector.CHUNK];
            for (int at = 0; at + chunk.length <= samples.length; at += chunk.length) {
                System.arraycopy(samples, at, chunk, 0, chunk.length);
                best = Math.max(best, detector.process(chunk));
            }
        }
        System.out.println(name + ": best score " + best);
        return best;
    }

    @Test
    public void hearsHeyJarvisInABritishVoice() throws Exception {
        float score = bestScore("hey_jarvis_gb.wav");
        assertTrue("score " + score, score > 0.9f);
    }

    @Test
    public void hearsHeyJarvisInAnIndianVoice() throws Exception {
        float score = bestScore("hey_jarvis_in.wav");
        assertTrue("score " + score, score > WakeWordDetector.THRESHOLD);
    }

    @Test
    public void ignoresOrdinarySpeech() throws Exception {
        float score = bestScore("not_wake.wav");
        assertTrue("score " + score, score < 0.3f);
    }
}
