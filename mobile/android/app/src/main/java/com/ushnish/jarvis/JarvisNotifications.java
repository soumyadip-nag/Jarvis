package com.ushnish.jarvis;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * Jarvis's view of the phone's notifications, with Android's "Notification access" (the user turns it on):
 * - who has messaged on WhatsApp, Messages, Instagram, Gmail and the like, as senders and counts only;
 * - "While you were away..." when the phone is unlocked after being left for a while (Settings: the hours);
 * - replies through a notification's own reply button ("reply to Rahul saying on my way");
 * - Do Not Disturb, which a notification listener may switch.
 * Android keeps this service running for as long as the access is on.
 */
public class JarvisNotifications extends NotificationListenerService {

    private static final String TAG = "JarvisNotifications";
    private static final String BRIEF_CHANNEL = "jarvis-briefing";
    private static final int BRIEF_NOTIFICATION = 4;

    static volatile JarvisNotifications instance;

    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            SharedPreferences prefs = getSharedPreferences(HandsFree.PREFS, MODE_PRIVATE);
            if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                if (prefs.getLong("awayFrom", 0) == 0) prefs.edit().putLong("awayFrom", System.currentTimeMillis()).apply();
            } else if (Intent.ACTION_USER_PRESENT.equals(intent.getAction())) {
                long awayFrom = prefs.getLong("awayFrom", 0);
                prefs.edit().remove("awayFrom").apply();
                if (awayFrom > 0) welcomeBack(awayFrom);
            }
        }
    };

    /** Whether the user has given Jarvis notification access. */
    static boolean allowed(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(new ComponentName(context, JarvisNotifications.class).flattenToString());
    }

    @Override
    public void onListenerConnected() {
        instance = this;
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screen, filter);
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
        try { unregisterReceiver(screen); } catch (IllegalArgumentException ignored) { }
    }

    // ───────── what's unread ─────────

    /** Unread messages that arrived since `since` (ms), senders and counts only. */
    List<Inbox.Unread> unread(long since) {
        List<Inbox.Unread> found = new ArrayList<>();
        StatusBarNotification[] active;
        try {
            active = getActiveNotifications();
        } catch (RuntimeException e) {
            return found;
        }
        if (active == null) return found;
        for (StatusBarNotification sbn : active) {
            if (!Inbox.APPS.containsKey(sbn.getPackageName())) continue;
            Notification n = sbn.getNotification();
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || (n.flags & Notification.FLAG_ONGOING_EVENT) != 0) continue;
            if (sbn.getPostTime() < since) continue;
            String from = sender(n);
            if (from == null || from.isEmpty()) continue;
            int count = 1;
            NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n);
            if (style != null && !style.getMessages().isEmpty()) {
                count = 0;
                for (NotificationCompat.MessagingStyle.Message m : style.getMessages()) if (m.getTimestamp() >= since) count++;
                if (count == 0) count = 1;
            }
            found.add(new Inbox.Unread(sbn.getPackageName(), from, count, sbn.getPostTime()));
        }
        return Inbox.merge(found);
    }

    /** The person, group or email sender a notification is from. */
    private static String sender(Notification n) {
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n);
        if (style != null && style.getConversationTitle() != null && style.isGroupConversation()) {
            return clean(style.getConversationTitle().toString());
        }
        CharSequence title = n.extras.getCharSequence(Notification.EXTRA_TITLE);
        return title == null ? null : clean(title.toString());
    }

    /** "Rahul (3 messages)" -> "Rahul"; "Family: Mom" stays as it is. */
    private static String clean(String title) {
        return title.replaceAll("\\s*\\(\\d+ (new )?messages?\\)$", "").trim();
    }

    // ───────── "while you were away" ─────────

    private void welcomeBack(long awayFrom) {
        SharedPreferences prefs = getSharedPreferences(HandsFree.PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean("briefing", true)) return;
        long away = System.currentTimeMillis() - awayFrom;
        if (away < (long) (prefs.getFloat("briefAfterHours", 2f) * 3_600_000L)) return;
        String text = Inbox.briefing(unread(awayFrom), prefs.getString("honorific", "sir"));
        if (text == null) return;
        Log.i(TAG, "briefing after " + away / 60000 + " min");
        new Thread(() -> {
            if (quietTime()) notifyBriefing(text);
            else new HandsFree(this, s -> { }).announce(text);
        }, "jarvis-briefing").start();
    }

    /** On silent, in a call or in Do Not Disturb, the briefing is a notification instead of being spoken. */
    private boolean quietTime() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return true;
        if (audio.getMode() == AudioManager.MODE_IN_CALL || audio.getMode() == AudioManager.MODE_IN_COMMUNICATION) return true;
        if (WakeWordService.conversing) return true;
        return getCurrentInterruptionFilter() > NotificationListenerService.INTERRUPTION_FILTER_ALL;
    }

    private void notifyBriefing(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(BRIEF_CHANNEL, "While you were away", NotificationManager.IMPORTANCE_DEFAULT));
        }
        PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        manager.notify(BRIEF_NOTIFICATION, new NotificationCompat.Builder(this, BRIEF_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Jarvis")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build());
    }

    // ───────── replying ─────────

    /** Replies through the newest matching notification's reply button. Returns what to say if it can't. */
    String reply(String to, String text, String app, String honorific) {
        String wanted = Inbox.appFor(app);
        StatusBarNotification[] active;
        try {
            active = getActiveNotifications();
        } catch (RuntimeException e) {
            return "I can't see your notifications at the moment, " + honorific + ".";
        }
        // Every conversation with a reply button whose name fits, then the best fit; the newest if several.
        List<StatusBarNotification> matches = new ArrayList<>();
        List<Notification.Action> actions = new ArrayList<>();
        List<Integer> fits = new ArrayList<>();
        int bestFit = 0;
        for (StatusBarNotification sbn : active == null ? new StatusBarNotification[0] : active) {
            if (!Inbox.APPS.containsKey(sbn.getPackageName()) || !Inbox.isApp(sbn.getPackageName(), wanted)) continue;
            Notification n = sbn.getNotification();
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
            Notification.Action action = replyAction(n);
            int fit = action == null ? 0 : Inbox.fit(sender(n), to);
            if (fit == 0) continue;
            matches.add(sbn);
            actions.add(action);
            fits.add(fit);
            bestFit = Math.max(bestFit, fit);
        }
        StatusBarNotification best = null;
        Notification.Action bestAction = null;
        java.util.Set<String> names = new java.util.HashSet<>();
        for (int i = 0; i < matches.size(); i++) {
            if (fits.get(i) != bestFit) continue;
            names.add(Inbox.simple(sender(matches.get(i).getNotification())));
            if (best == null || matches.get(i).getPostTime() > best.getPostTime()) {
                best = matches.get(i);
                bestAction = actions.get(i);
            }
        }
        if (best == null) {
            return "I can only reply to messages still in your notifications, " + honorific + ", and there's nothing there from " + to + ".";
        }
        if (names.size() > 1 && bestFit < 3) return "More than one conversation matches " + to + ", " + honorific + ". Which one?";
        Intent filled = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput input : bestAction.getRemoteInputs()) results.putCharSequence(input.getResultKey(), text);
        RemoteInput.addResultsToIntent(bestAction.getRemoteInputs(), filled, results);
        try {
            bestAction.actionIntent.send(this, 0, filled);
        } catch (PendingIntent.CanceledException e) {
            return "That conversation's reply button has gone, " + honorific + ". Open the app to reply.";
        }
        return null;
    }

    /** A notification's reply button: an action that takes typed text. */
    private static Notification.Action replyAction(Notification n) {
        if (n.actions == null) return null;
        Notification.Action fallback = null;
        for (Notification.Action action : n.actions) {
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null || inputs.length == 0) continue;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && action.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_REPLY) return action;
            if (fallback == null) fallback = action;
        }
        return fallback;
    }

    /** Sender names the AI may see, so that "who messaged me?" can be answered. Never what they wrote. */
    static String summaryForAi(Context context) {
        JarvisNotifications self = instance;
        if (self == null) return null;
        List<Inbox.Unread> list = self.unread(System.currentTimeMillis() - 24 * 3_600_000L);
        StringBuilder out = new StringBuilder();
        long now = System.currentTimeMillis();
        for (Inbox.Unread u : list) {
            if (out.length() > 1500) break;
            out.append("- ").append(u.count).append(" on ").append(u.appName()).append(" from ").append(u.from)
                .append(", newest ").append(Math.max(1, (now - u.latest) / 60000)).append(" min ago\n");
        }
        return out.toString();
    }
}
