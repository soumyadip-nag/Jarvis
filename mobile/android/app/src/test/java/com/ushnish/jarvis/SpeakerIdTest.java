package com.ushnish.jarvis;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Voice ID against recordings whose scores the Python version gives: one voice enrolled from five "Hey Jarvis",
 * then a new take of that voice (0.821) and two other voices (0.302 and 0.223).
 */
public class SpeakerIdTest {

    private static SpeakerId id;
    private static float[] owner;

    @BeforeClass
    public static void setUp() throws Exception {
        File model = new File("build/speaker-model/" + SpeakerId.MODEL);
        model.getParentFile().mkdirs();
        if (!model.exists()) {
            try (InputStream in = new URL(SpeakerId.MODEL_URL).openStream(); FileOutputStream out = new FileOutputStream(model)) {
                in.transferTo(out);
            }
        }
        id = new SpeakerId(model);
        List<float[]> prints = new ArrayList<>();
        for (int i = 0; i < 5; i++) prints.add(id.print(load("voice_owner_" + i + ".wav")));
        owner = SpeakerId.average(prints);
    }

    @AfterClass
    public static void tearDown() throws Exception {
        id.close();
    }

    static short[] load(String name) throws Exception {
        byte[] bytes;
        try (InputStream in = SpeakerIdTest.class.getClassLoader().getResourceAsStream(name)) {
            bytes = new DataInputStream(in).readAllBytes();
        }
        ByteBuffer data = ByteBuffer.wrap(bytes, 44, bytes.length - 44).order(ByteOrder.LITTLE_ENDIAN);
        short[] samples = new short[data.remaining() / 2];
        data.asShortBuffer().get(samples);
        return samples;
    }

    private static float score(String name) throws Exception {
        float s = SpeakerId.similarity(owner, id.print(load(name)));
        System.out.println(name + ": " + s);
        return s;
    }

    @Test
    public void featuresMatchPython() throws Exception {
        float[][] f = SpeakerId.features(load("voice_owner_again.wav"));
        assertEquals(198, f.length);
        assertEquals(12.3172, f[50][0], 0.01);
        assertEquals(13.9999, f[50][10], 0.01);
        assertEquals(10.8328, f[50][40], 0.01);
        assertEquals(4.7212, f[50][79], 0.01);
    }

    @Test
    public void knowsTheOwner() throws Exception {
        float s = score("voice_owner_again.wav");
        assertEquals(0.821, s, 0.02);
        assertTrue(s > SpeakerId.NORMAL);
    }

    @Test
    public void rejectsOtherVoices() throws Exception {
        float indian = score("voice_other_in.wav");
        float american = score("voice_other_us.wav");
        assertEquals(0.302, indian, 0.02);
        assertEquals(0.223, american, 0.02);
        assertTrue(indian < SpeakerId.NORMAL && american < SpeakerId.NORMAL);
    }
}
