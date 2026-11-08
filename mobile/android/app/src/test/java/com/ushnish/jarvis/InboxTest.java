package com.ushnish.jarvis;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

/** The "while you were away" wording and matching a spoken name to a conversation. */
public class InboxTest {

    private static Inbox.Unread u(String app, String from, int count, long latest) {
        return new Inbox.Unread(app, from, count, latest);
    }

    @Test
    public void nothingToSay() {
        assertNull(Inbox.briefing(Collections.emptyList(), "sir"));
    }

    @Test
    public void briefing() {
        String text = Inbox.briefing(Arrays.asList(
            u("com.whatsapp", "Rahul", 3, 20),
            u("com.whatsapp", "Mom", 2, 30),
            u("com.whatsapp", "rahul", 1, 10),
            u("com.google.android.apps.messaging", "HDFC Bank", 2, 5),
            u("com.google.android.gm", "Amazon", 1, 1)), "sir");
        assertEquals("While you were away, sir: 6 WhatsApp messages from Mom and Rahul, 2 texts from HDFC Bank "
            + "and an email from Amazon.", text);
    }

    @Test
    public void manyPeople() {
        String text = Inbox.briefing(Arrays.asList(
            u("com.instagram.android", "A", 1, 4), u("com.instagram.android", "B", 1, 3),
            u("com.instagram.android", "C", 1, 2), u("com.instagram.android", "D", 1, 1)), "sir");
        assertEquals("While you were away, sir: 4 Instagram messages from A, B and 2 others.", text);
    }

    @Test
    public void names() {
        assertEquals(3, Inbox.fit("Rahul", "rahul"));
        assertEquals(2, Inbox.fit("Rahul Sen", "Rahul"));
        assertEquals(3, Inbox.fit("Mom ❤️", "mom"));
        assertEquals(1, Inbox.fit("Rahul Sen", "Rah"));
        assertEquals(0, Inbox.fit("Rahul", "Riya"));
        assertEquals(0, Inbox.fit("Rahul", ""));
    }

    @Test
    public void apps() {
        assertEquals("com.whatsapp", Inbox.appFor("WhatsApp"));
        assertEquals("com.instagram.android", Inbox.appFor("insta"));
        assertEquals("messages", Inbox.appFor("sms"));
        assertNull(Inbox.appFor(""));
        assertTrue(Inbox.isApp("com.samsung.android.messaging", "messages"));
        assertTrue(Inbox.isApp("com.whatsapp.w4b", "com.whatsapp"));
        assertTrue(Inbox.isApp("com.whatsapp", null));
    }
}
