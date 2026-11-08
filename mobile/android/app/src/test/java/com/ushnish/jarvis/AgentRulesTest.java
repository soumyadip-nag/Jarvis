package com.ushnish.jarvis;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The rules the phone enforces whatever the AI suggests. */
public class AgentRulesTest {

    @Test
    public void riskyTapsAreAskedAbout() {
        assertTrue(AgentRules.isRisky("send"));
        assertTrue(AgentRules.isRisky("Send message send_button"));
        assertTrue(AgentRules.isRisky("Place order"));
        assertTrue(AgentRules.isRisky("Delete chat"));
        assertTrue(AgentRules.isRisky("Pay ₹200"));
        assertTrue(AgentRules.isRisky("Post"));
        assertFalse(AgentRules.isRisky("Chats"));
        assertFalse(AgentRules.isRisky("Search"));
        assertFalse(AgentRules.isRisky("Rahul"));
        assertFalse(AgentRules.isRisky("Settings"));
        assertFalse(AgentRules.isRisky(""));
        assertFalse(AgentRules.isRisky(null));
    }

    @Test
    public void moneyAndPasswordAppsAreBlocked() {
        assertTrue(AgentRules.isBlocked("com.google.android.apps.nbu.paisa.user", "Google Pay"));
        assertTrue(AgentRules.isBlocked("com.phonepe.app", "PhonePe"));
        assertTrue(AgentRules.isBlocked("com.sbi.lotusintouch", "YONO SBI"));
        assertTrue(AgentRules.isBlocked("com.csam.icici.bank.imobile", "iMobile Pay"));
        assertTrue(AgentRules.isBlocked("com.x8bit.bitwarden", "Bitwarden"));
        assertTrue(AgentRules.isBlocked("com.example.thing", "HDFC Bank"));
        assertFalse(AgentRules.isBlocked("com.whatsapp", "WhatsApp"));
        assertFalse(AgentRules.isBlocked("com.instagram.android", "Instagram"));
        assertFalse(AgentRules.isBlocked("com.spotify.music", "Spotify"));
        assertFalse(AgentRules.isBlocked("com.android.vending", "Google Play Store"));
        assertFalse(AgentRules.isBlocked("com.android.settings", "Settings"));
    }

    @Test
    public void onlyAClearYesCounts() {
        assertTrue(AgentRules.saidYes("Yes"));
        assertTrue(AgentRules.saidYes("yeah go ahead"));
        assertTrue(AgentRules.saidYes("Send it."));
        assertFalse(AgentRules.saidYes("no"));
        assertFalse(AgentRules.saidYes("wait"));
        assertFalse(AgentRules.saidYes("not yet"));
        assertFalse(AgentRules.saidYes(""));
        assertFalse(AgentRules.saidYes(null));
    }
}
