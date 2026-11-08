package com.ushnish.jarvis;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Does a task inside other apps ("send Rahul a WhatsApp saying I'm late"): reads the screen, asks the server's AI for
 * the next step, checks it against AgentRules, does it, and repeats until done. It asks the user out loud before any
 * tap that can't be undone, refuses money and password apps, and stops after MAX_STEPS or on "Stop" in its
 * notification. At the end it says how it went and adds that to the chat.
 */
final class PhoneAgent {

    private static final String TAG = "JarvisAgent";
    private static final String CHANNEL = "jarvis-agent";
    private static final String ACTION_STOP = "com.ushnish.jarvis.STOP_AGENT";
    private static final int NOTIFICATION = 5;
    static final int MAX_STEPS = 25;
    private static final long MAX_MS = 4 * 60_000L;
    private static final int HISTORY = 10;

    static volatile boolean running = false;
    private static volatile boolean stopRequested = false;

    private final Context context;
    private final String goal;
    private final SharedPreferences prefs;
    private final List<String> history = new ArrayList<>();
    private String lastTyped;

    private PhoneAgent(Context context, String goal) {
        this.context = context.getApplicationContext();
        this.goal = goal;
        this.prefs = context.getSharedPreferences(HandsFree.PREFS, Context.MODE_PRIVATE);
    }

    /** Starts a task in the background. Returns null, or why it can't start. */
    static String start(Context context, String goal, String honorific) {
        if (goal == null || goal.trim().isEmpty()) return "What would you like me to do, " + honorific + "?";
        if (JarvisAccessibility.instance == null) {
            return "To work inside your apps I need accessibility access, " + honorific + ". You'll find it in my settings.";
        }
        if (!HandsFree.ready(context)) return "Please open Jarvis once so I can sign in for that, " + honorific + ".";
        synchronized (PhoneAgent.class) {
            if (running) return "I'm already in the middle of a task, " + honorific + ".";
            running = true;
            stopRequested = false;
        }
        PhoneAgent agent = new PhoneAgent(context, goal.trim());
        new Thread(agent::run, "jarvis-agent").start();
        return null;
    }

    static void stop() {
        stopRequested = true;
    }

    private String honorific() {
        return prefs.getString("honorific", "sir");
    }

    private void run() {
        BroadcastReceiver stopper = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { stopRequested = true; }
        };
        ContextCompat.registerReceiver(context, stopper, new IntentFilter(ACTION_STOP), ContextCompat.RECEIVER_NOT_EXPORTED);
        HandsFree voice = new HandsFree(context, s -> { });
        String summary;
        boolean ok = false;
        try {
            show("Starting…");
            Thread.sleep(1500); // let "On it" finish
            long started = System.currentTimeMillis();
            String answer = null;
            summary = "I ran out of steps before finishing, " + honorific() + ".";
            for (int step = 0; step < MAX_STEPS; step++) {
                if (stopRequested) { summary = "Stopped, " + honorific() + "."; break; }
                if (System.currentTimeMillis() - started > MAX_MS) { summary = "That was taking too long, so I stopped, " + honorific() + "."; break; }
                JarvisAccessibility hands = JarvisAccessibility.instance;
                if (hands == null) { summary = "I lost accessibility access, " + honorific() + "."; break; }
                if (HandsFree.locked(context)) { summary = "Your phone locked, so I stopped, " + honorific() + "."; break; }

                JarvisAccessibility.Screen screen = hands.read();
                if (AgentRules.isBlocked(screen.pkg, screen.appName)) {
                    summary = "I don't operate banking, payment or password apps, " + honorific() + ", so I stopped.";
                    break;
                }
                JSONObject next = nextStep(screen, answer, step);
                answer = null;
                String action = next.optString("action");
                show(next.optString("say", action));
                Log.i(TAG, "step " + step + ": " + next);

                if (action.equals("done")) {
                    summary = next.optString("summary", "Done, " + honorific() + ".");
                    ok = true;
                    break;
                }
                if (action.equals("fail")) {
                    summary = next.optString("summary", "I couldn't do that, " + honorific() + ".");
                    break;
                }
                if (action.equals("ask")) {
                    String question = next.optString("question");
                    answer = voice.ask(question);
                    remember("asked the user \"" + question + "\"; they said \"" + answer + "\"");
                    continue;
                }

                // The rules: a tap that can't be undone, or pressing enter in a messaging app, is asked about first.
                String risky = JarvisAccessibility.riskLabel(next, screen);
                boolean submitInChat = action.equals("submit") && Inbox.APPS.containsKey(screen.pkg);
                if (AgentRules.isRisky(risky) || submitInChat) {
                    String what = risky.isEmpty() ? "send it" : "tap \"" + JarvisAccessibility.label(JarvisAccessibility.clickable(screen.items.get(next.optInt("id")))) + "\"";
                    String question = "Shall I " + what + " in " + screen.appName + "?"
                        + (lastTyped != null ? " The text is: " + lastTyped + "." : "");
                    String reply = voice.ask(question);
                    if (!AgentRules.saidYes(reply)) {
                        summary = "All right, I didn't. Nothing was sent, " + honorific() + ".";
                        break;
                    }
                    remember("the user agreed to " + what);
                }
                if (action.equals("type")) lastTyped = next.optString("text");

                String result = hands.act(next, screen);
                remember(describe(next) + " -> " + result);
                if (result.startsWith("BLOCKED")) {
                    summary = "I don't operate banking, payment or password apps, " + honorific() + ".";
                    break;
                }
                Thread.sleep(action.equals("open_app") ? 2500 : 1200); // let the screen settle
            }
        } catch (Exception e) {
            Log.e(TAG, "task failed", e);
            summary = "Something went wrong part way through, " + honorific() + ": " + e.getMessage();
        } finally {
            try { context.unregisterReceiver(stopper); } catch (IllegalArgumentException ignored) { }
        }
        finish(voice, summary, ok);
    }

    private void finish(HandsFree voice, String summary, boolean ok) {
        context.getSystemService(NotificationManager.class).cancel(NOTIFICATION);
        try {
            voice.speak(summary);
        } finally {
            voice.close();
        }
        try {
            post("/api/agent/report", new JSONObject().put("goal", goal).put("summary", summary).put("ok", ok));
        } catch (Exception e) {
            Log.w(TAG, "report failed", e);
        }
        running = false;
    }

    private void remember(String line) {
        history.add(line);
        while (history.size() > HISTORY) history.remove(0);
    }

    private static String describe(JSONObject step) {
        StringBuilder out = new StringBuilder(step.optString("action"));
        if (step.has("id")) out.append(" [").append(step.optInt("id")).append(']');
        if (step.has("name")) out.append(" \"").append(step.optString("name")).append('"');
        if (step.has("text")) out.append(" \"").append(step.optString("text")).append('"');
        if (step.has("direction")) out.append(' ').append(step.optString("direction"));
        return out.toString();
    }

    // ───────── the server's AI ─────────

    private JSONObject nextStep(JarvisAccessibility.Screen screen, String answer, int step) throws Exception {
        JSONObject body = new JSONObject()
            .put("goal", goal)
            .put("app", screen.appName)
            .put("screen", screen.text.toString())
            .put("history", new JSONArray(history))
            .put("step", step);
        if (answer != null) body.put("answer", answer);
        JSONObject out = post("/api/agent/step", body);
        JSONObject action = out.optJSONObject("action");
        return action != null ? action : new JSONObject().put("action", "fail").put("summary", "I lost my way, " + honorific() + ".");
    }

    private JSONObject post(String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(prefs.getString("server", "") + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(45000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + prefs.getString("token", ""));
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            try (InputStream in = code < 400 ? connection.getInputStream() : connection.getErrorStream()) {
                String text = in == null ? "{}" : new String(readAll(in), StandardCharsets.UTF_8);
                JSONObject json = new JSONObject(text.isEmpty() ? "{}" : text);
                if (code >= 400) throw new IllegalStateException(json.optString("error", "HTTP " + code));
                return json;
            }
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) bytes.write(buffer, 0, n);
        return bytes.toByteArray();
    }

    // ───────── the notification, with Stop ─────────

    private void show(String text) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Jarvis working in your apps", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent stop = PendingIntent.getBroadcast(context, 3,
            new Intent(ACTION_STOP).setPackage(context.getPackageName()), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentTitle("Jarvis: " + (goal.length() > 60 ? goal.substring(0, 60) + "…" : goal))
            .setContentText(text)
            .setOngoing(true)
            .addAction(0, "Stop", stop)
            .build();
        manager.notify(NOTIFICATION, n);
    }
}
