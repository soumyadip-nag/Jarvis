package com.ushnish.jarvis;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The rules for operating other apps, enforced here on the phone rather than left to the AI: the AI only suggests the
 * next step, and text on the screen (a message, a web page) could try to talk it into something.
 * Plain Java, so the rules are unit-tested.
 */
final class AgentRules {

    private AgentRules() { }

    /** Taps that can't be undone: the user is asked out loud first. */
    private static final Pattern RISKY = Pattern.compile(
        "\\b(send|pay|payment|buy|purchase|order|checkout|check out|post|publish|share|tweet|upload|delete|remove|erase|"
            + "uninstall|transfer|submit|confirm|book|subscribe|unsubscribe|call|dial|reply|sign out|log out|logout|report|"
            + "block|unfollow|unfriend|accept|decline|install|place|donate|withdraw|archive|forward|discard|reset|wipe)\\b",
        Pattern.CASE_INSENSITIVE);

    /** Money and passwords: Jarvis doesn't operate these apps at all. */
    private static final String[] BLOCKED_PACKAGES = {
        "com.google.android.apps.nbu.paisa.user", // Google Pay
        "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp", "in.amazon.mShop.android.shopping.pay",
        "com.mobikwik_new", "com.freecharge.android", "com.dreamplug.androidapp", // CRED
        "com.paypal.android.p2pmobile", "com.google.android.apps.walletnfcrel",
        "com.x8bit.bitwarden", "com.lastpass.lpandroid", "com.agilebits.onepassword", "com.dashlane",
        "com.google.android.apps.authenticator2", "com.azure.authenticator", "com.authy.authy",
        "com.binance.dev", "com.coinbase.android", "com.wazirx", "com.zerodha.kite3", "com.groww", "com.upstox.pro",
    };
    private static final Pattern BLOCKED_WORDS = Pattern.compile(
        "bank|\\bpay\\b|\\bupi\\b|wallet|password|authenticator|\\bsbi\\b|hdfc|icici|\\baxis\\b|kotak|yono|imobile|"
            + "crypto|\\btrading\\b|demat|\\bstocks?\\b|\\bloans?\\b|credit card",
        Pattern.CASE_INSENSITIVE);

    /** "yes", "yeah go ahead", "send it" */
    private static final Pattern YES = Pattern.compile(
        "^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|send it|confirm|please do|go on|affirmative|correct|right)\\b.*");

    static boolean isRisky(String label) {
        return label != null && RISKY.matcher(label).find();
    }

    /** Whether an app is about money or passwords, by its package or its name. */
    static boolean isBlocked(String pkg, String appName) {
        if (pkg != null) {
            for (String blocked : BLOCKED_PACKAGES) if (pkg.equals(blocked)) return true;
            if (BLOCKED_WORDS.matcher(pkg.replace('.', ' ')).find()) return true;
        }
        return appName != null && BLOCKED_WORDS.matcher(appName).find();
    }

    static boolean saidYes(String answer) {
        return answer != null && YES.matcher(HandsFree.plainWords(answer).toLowerCase(Locale.ROOT)).matches();
    }
}
