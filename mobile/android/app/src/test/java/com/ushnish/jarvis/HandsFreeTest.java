package com.ushnish.jarvis;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The phrases that end a hands-free conversation or put Jarvis to sleep, as the app (app.js) reads them. */
public class HandsFreeTest {

    private static boolean ends(String text) {
        return HandsFree.END_PHRASE.matcher(HandsFree.plainWords(text)).matches();
    }

    private static boolean sleeps(String text) {
        return HandsFree.SLEEP_PHRASE.matcher(HandsFree.plainWords(text)).find();
    }

    @Test
    public void plainWords() {
        assertEquals("thats all", HandsFree.plainWords("That's all."));
    }

    @Test
    public void endPhrases() {
        assertTrue(ends("That's all"));
        assertTrue(ends("Okay, that's all, Jarvis."));
        assertTrue(ends("Nothing else"));
        assertFalse(ends("Is that all of my meetings today?"));
    }

    @Test
    public void sleepPhrases() {
        assertTrue(sleeps("Go to sleep"));
        assertTrue(sleeps("Jarvis, stop listening."));
        assertFalse(ends("What time do I usually sleep?") || sleeps("What time do I usually sleep?"));
    }
}
