package com.ushnish.jarvis;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * What's unread in the messaging apps, as senders and counts only: what people wrote never leaves the phone.
 * Plain Java (no Android), so the wording and the name matching can be tested off the phone.
 */
final class Inbox {

    /** The apps Jarvis keeps track of, and how to speak of their messages: {name, one message, many}. */
    static final Map<String, String[]> APPS = new LinkedHashMap<>();
    static {
        APPS.put("com.whatsapp", new String[] { "WhatsApp", "WhatsApp message", "WhatsApp messages" });
        APPS.put("com.whatsapp.w4b", new String[] { "WhatsApp Business", "WhatsApp Business message", "WhatsApp Business messages" });
        APPS.put("com.google.android.apps.messaging", new String[] { "Messages", "text", "texts" });
        APPS.put("com.samsung.android.messaging", new String[] { "Messages", "text", "texts" });
        APPS.put("com.instagram.android", new String[] { "Instagram", "Instagram message", "Instagram messages" });
        APPS.put("com.google.android.gm", new String[] { "Gmail", "email", "emails" });
        APPS.put("org.telegram.messenger", new String[] { "Telegram", "Telegram message", "Telegram messages" });
        APPS.put("com.facebook.orca", new String[] { "Messenger", "Messenger message", "Messenger messages" });
        APPS.put("com.snapchat.android", new String[] { "Snapchat", "Snapchat message", "Snapchat messages" });
    }

    /** One conversation (or one email sender) with unread messages. */
    static final class Unread {
        final String app;   // package name
        final String from;  // the person, group or email sender, as the notification shows it
        final int count;
        final long latest;  // when the newest arrived, in ms

        Unread(String app, String from, int count, long latest) {
            this.app = app;
            this.from = from;
            this.count = count;
            this.latest = latest;
        }

        String appName() {
            String[] names = APPS.get(app);
            return names == null ? app : names[0];
        }
    }

    /** Several notifications from the same person in the same app become one entry. */
    static List<Unread> merge(List<Unread> items) {
        Map<String, Unread> merged = new LinkedHashMap<>();
        for (Unread u : items) {
            String key = u.app + "\n" + u.from.toLowerCase(Locale.ROOT);
            Unread had = merged.get(key);
            merged.put(key, had == null ? u : new Unread(u.app, had.from, had.count + u.count, Math.max(had.latest, u.latest)));
        }
        return new ArrayList<>(merged.values());
    }

    /**
     * "While you were away, sir: 5 WhatsApp messages from Rahul and Mom, 2 texts from HDFC Bank, and an email from
     * Amazon." Returns null when there's nothing to tell.
     */
    static String briefing(List<Unread> unread, String honorific) {
        Map<String, List<Unread>> byApp = new LinkedHashMap<>();
        for (Unread u : merge(unread)) {
            String name = u.appName();
            byApp.computeIfAbsent(name, k -> new ArrayList<>()).add(u);
        }
        if (byApp.isEmpty()) return null;
        List<String> parts = new ArrayList<>();
        for (List<Unread> list : byApp.values()) {
            list.sort((a, b) -> Long.compare(b.latest, a.latest));
            int count = 0;
            for (Unread u : list) count += u.count;
            String[] names = APPS.get(list.get(0).app);
            String what = names == null ? (count == 1 ? "message" : "messages") : (count == 1 ? names[1] : names[2]);
            String amount = count == 1 ? ("aeiou".indexOf(Character.toLowerCase(what.charAt(0))) >= 0 ? "an" : "a") : String.valueOf(count);
            parts.add(amount + " " + what + " from " + people(list));
        }
        return "While you were away, " + honorific + ": " + join(parts) + ".";
    }

    /** "Rahul", "Rahul and Mom", "Rahul, Mom and 3 others" */
    private static String people(List<Unread> list) {
        List<String> names = new ArrayList<>();
        for (int i = 0; i < Math.min(2, list.size()); i++) names.add(list.get(i).from);
        int rest = list.size() - names.size();
        if (rest == 1) names.add(list.get(2).from);
        else if (rest > 1) names.add(rest + " others");
        return join(names);
    }

    private static String join(List<String> parts) {
        if (parts.size() == 1) return parts.get(0);
        return String.join(", ", parts.subList(0, parts.size() - 1)) + " and " + parts.get(parts.size() - 1);
    }

    /** Lower case letters and digits only, for comparing names: "Mom ❤️" -> "mom". */
    static String simple(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N} ]", "").replaceAll("\\s+", " ").trim();
    }

    /**
     * How well a conversation's name fits the name said: 3 exact, 2 a whole word of it ("Rahul" for "Rahul Sen"),
     * 1 the start of a word, 0 not at all.
     */
    static int fit(String conversation, String said) {
        String c = simple(conversation);
        String s = simple(said);
        if (s.isEmpty() || c.isEmpty()) return 0;
        if (c.equals(s)) return 3;
        if ((" " + c + " ").contains(" " + s + " ")) return 2;
        for (String word : c.split(" ")) if (word.startsWith(s) && s.length() >= 3) return 1;
        return 0;
    }

    /** Which app a spoken name means: "whatsapp", "insta", "text"... or null for any. */
    static String appFor(String said) {
        String s = simple(said);
        if (s.isEmpty()) return null;
        if (s.contains("whatsapp")) return "com.whatsapp";
        if (s.contains("insta")) return "com.instagram.android";
        if (s.contains("telegram")) return "org.telegram.messenger";
        if (s.contains("messenger") || s.contains("facebook")) return "com.facebook.orca";
        if (s.contains("snap")) return "com.snapchat.android";
        if (s.contains("sms") || s.contains("text") || s.contains("message")) return "messages";
        return null;
    }

    /** Whether a package is the app meant ("messages" covers both texting apps). */
    static boolean isApp(String pkg, String wanted) {
        if (wanted == null) return true;
        if (wanted.equals("messages")) return pkg.equals("com.google.android.apps.messaging") || pkg.equals("com.samsung.android.messaging");
        return pkg.equals(wanted) || (wanted.equals("com.whatsapp") && pkg.equals("com.whatsapp.w4b"));
    }
}
