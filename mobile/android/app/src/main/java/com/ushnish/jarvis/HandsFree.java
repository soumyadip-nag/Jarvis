package com.ushnish.jarvis;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * A whole conversation without opening the app: after "Hey Jarvis" it beeps, listens with Android's speech
 * recogniser, sends what was said to the server and speaks the reply in Jarvis's voice as it's written. Follow-ups
 * don't need "Hey Jarvis" again; silence or "that's all" ends it, and "go to sleep" stops listening altogether.
 * The page passes the server, the sign-in and the settings this needs (see JarvisNativePlugin.startWakeWord).
 */
final class HandsFree {

    static final String PREFS = "jarvis-wake";

    /** The same phrases as the app (app.js), on text from plainWords(). */
    static final Pattern END_PHRASE = Pattern.compile(
        "^((thank you|thanks|ok|okay) )?(thats all|that is all|nothing else|never ?mind|thats it)( (jarvis|for now|thanks|thank you))?$");
    static final Pattern SLEEP_PHRASE = Pattern.compile("\\b(go to sleep|sleep mode|stop listening)\\b");
    private static final int MAX_TURNS = 8;
    private static final int VOICED_SENTENCES = 4; // the server voices this many (api.mjs)

    enum Outcome { DONE, SLEEP, NEEDS_APP }

    interface Status { void show(String text); }

    /** "That's all." -> "thats all" */
    static String plainWords(String text) {
        return text.toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", "").replaceAll("\\s+", " ").trim();
    }

    /** Whether the phone is locked: then whoever is speaking may not be the user, so nothing personal. */
    static boolean locked(Context context) {
        android.app.KeyguardManager keyguard = context.getSystemService(android.app.KeyguardManager.class);
        return keyguard != null && keyguard.isKeyguardLocked();
    }

    /** Whether the page has signed in and passed on what a conversation needs. */
    static boolean ready(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getString("token", null) != null && prefs.getString("server", null) != null;
    }

    private final Context context;
    private final Status status;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private volatile boolean ttsReady;
    private AudioFocusRequest focus;
    private boolean handedOff;
    private volatile boolean callMode; // listening through Bluetooth headphones, which are then in "call" mode

    HandsFree(Context context, Status status) {
        this.context = context;
        this.status = status;
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String honorific() {
        return prefs.getString("honorific", "sir");
    }

    /** Runs on the wake-word thread, which isn't using the microphone meanwhile. */
    Outcome run() {
        Outcome outcome = Outcome.DONE;
        boolean headset = false;
        try {
            beep();
            headset = callMode = useHeadsetMicrophone();
            for (int turn = 0; turn < MAX_TURNS; turn++) {
                status.show("Listening…");
                String text = listen();
                if (text == null || text.isEmpty()) break;
                String said = plainWords(text);
                if (SLEEP_PHRASE.matcher(said).find()) {
                    say("Going to sleep, " + honorific() + ". Open Jarvis when you need me.");
                    outcome = Outcome.SLEEP;
                    break;
                }
                if (END_PHRASE.matcher(said).matches()) {
                    say("Very good, " + honorific() + ".");
                    break;
                }
                status.show("Thinking…");
                if (chat(text)) {
                    outcome = Outcome.NEEDS_APP;
                    break;
                }
                if (handedOff) break; // a phone task has the screen now
            }
        } catch (Exception e) {
            Log.e("JarvisHandsFree", "conversation failed", e);
            try { say("Sorry, " + honorific() + ", something went wrong."); } catch (Exception ignored) { }
        } finally {
            if (headset) releaseHeadsetMicrophone();
            abandonFocus();
            if (tts != null) main.post(() -> { tts.shutdown(); });
        }
        return outcome;
    }

    // ───────── Bluetooth headphones ─────────

    /**
     * With Bluetooth headphones on, the conversation listens through their microphone, so it hears you with the phone
     * in a pocket. This puts them in "call" mode (as in a phone call), so only for the conversation: "Hey Jarvis"
     * itself is heard by the phone's microphone, and music sounds normal the rest of the time.
     */
    private boolean useHeadsetMicrophone() throws InterruptedException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        AudioManager audio = context.getSystemService(AudioManager.class);
        for (android.media.AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
            if (device.getType() != android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                && device.getType() != android.media.AudioDeviceInfo.TYPE_BLE_HEADSET) continue;
            if (!audio.setCommunicationDevice(device)) return false;
            Thread.sleep(800); // the headphones take a moment to switch
            Log.i("JarvisHandsFree", "listening through " + device.getProductName());
            return true;
        }
        return false;
    }

    private void releaseHeadsetMicrophone() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) context.getSystemService(AudioManager.class).clearCommunicationDevice();
    }

    // ───────── listening ─────────

    private void beep() throws InterruptedException {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 70);
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 150);
            Thread.sleep(250);
            tone.release();
        } catch (RuntimeException e) {
            Log.w("JarvisHandsFree", "no beep", e); // the conversation matters more than the beep
        }
    }

    /** What was said, "" for nothing, or null if listening failed. */
    private String listen() throws InterruptedException {
        for (int attempt = 0; attempt < 2; attempt++) {
            String[] result = { null };
            int[] error = { 0 };
            CountDownLatch finished = new CountDownLatch(1);
            SpeechRecognizer[] recognizer = { null };
            main.post(() -> {
                if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                    error[0] = -1;
                    finished.countDown();
                    return;
                }
                recognizer[0] = SpeechRecognizer.createSpeechRecognizer(context);
                recognizer[0].setRecognitionListener(new RecognitionListener() {
                    @Override public void onResults(Bundle results) {
                        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        result[0] = matches == null || matches.isEmpty() ? "" : matches.get(0);
                        finished.countDown();
                    }
                    @Override public void onError(int code) {
                        error[0] = code;
                        if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) result[0] = "";
                        finished.countDown();
                    }
                    @Override public void onReadyForSpeech(Bundle params) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() {}
                    @Override public void onPartialResults(Bundle partialResults) {}
                    @Override public void onEvent(int eventType, Bundle params) {}
                });
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, prefs.getString("lang", "en-IN"));
                recognizer[0].startListening(intent);
            });
            boolean answered = finished.await(20, TimeUnit.SECONDS);
            main.post(() -> { if (recognizer[0] != null) recognizer[0].destroy(); });
            Thread.sleep(300); // a new recogniser straight after destroying one fails with error 11
            if (!answered) return "";
            if (result[0] != null) return result[0];
            Log.w("JarvisHandsFree", "speech recognition error " + error[0]);
            // Android's speech service can drop the first attempt (errors 5, 8 and 11); a second one usually works.
            if (attempt == 0 && (error[0] == 5 || error[0] == 8 || error[0] == 11)) continue;
            return null;
        }
        return null;
    }

    /** Says something unprompted (the "while you were away" briefing) in Jarvis's voice, or the phone's if that fails. */
    void announce(String text) {
        try {
            speak(text);
        } finally {
            close();
        }
    }

    /** Says something in Jarvis's voice, or the phone's if that fails. Call close() when finished talking. */
    void speak(String text) {
        try {
            byte[] mp3 = null;
            try {
                mp3 = fetchVoice(text);
            } catch (Exception e) {
                Log.w("JarvisHandsFree", "voice failed", e);
            }
            if (mp3 != null && mp3.length > 0) play(mp3);
            else say(text);
        } catch (Exception e) {
            Log.e("JarvisHandsFree", "speaking failed", e);
        }
    }

    /**
     * Asks a question out loud and returns the answer, "" if none. The "Hey Jarvis" listener lets go of the
     * microphone meanwhile.
     */
    String ask(String question) throws InterruptedException {
        speak(question);
        boolean wasPaused = WakeWordService.paused;
        WakeWordService.paused = true;
        try {
            Thread.sleep(300); // the wake-word thread releases the microphone
            beep();
            String heard = listen();
            return heard == null ? "" : heard;
        } finally {
            WakeWordService.paused = wasPaused;
        }
    }

    void close() {
        abandonFocus();
        if (tts != null) main.post(() -> tts.shutdown());
        ttsReady = false;
    }

    private byte[] fetchVoice(String text) throws Exception {
        if (!ready(context)) return null;
        HttpURLConnection connection = (HttpURLConnection) new URL(prefs.getString("server", "") + "/api/speak").openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(20000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + prefs.getString("token", ""));
            try (OutputStream out = connection.getOutputStream()) {
                out.write(new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() != 200) return null;
            try (java.io.InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[16384];
                int n;
                while ((n = in.read(buffer)) != -1) bytes.write(buffer, 0, n);
                return bytes.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    // ───────── talking to the server ─────────

    /** The reply as it streams in: its sentences, and the audio the server made for the first few. */
    private static final class Reply {
        final List<String> sentences = new ArrayList<>();
        final Map<Integer, byte[]> audio = new HashMap<>(); // an empty array: the server couldn't voice it
        boolean done;
        boolean handedOff; // a phone task started: it has the screen now, so the conversation ends
        boolean finished; // the connection closed: no more audio is coming
        String content = "";
        JSONArray actions = new JSONArray();
        String error;
    }

    /** Sends what was said and speaks the reply. Returns true if the reply needs the app (a call, a link). */
    private boolean chat(String text) throws Exception {
        Reply reply = new Reply();
        Thread reader = new Thread(() -> stream(text, reply), "jarvis-hands-free-chat");
        reader.start();

        int next = 0;
        boolean shortened = false;
        for (;;) {
            String sentence = null;
            byte[] voiced = null;
            synchronized (reply) {
                // Before the reply is finished, only the first two sentences are certain to be read out:
                // longer replies are cut short the same way as in the app.
                while (true) {
                    boolean planned = reply.done || next < 2;
                    if (reply.error != null) break;
                    if (reply.done && next >= plannedCount(reply)) break;
                    if (planned && next < reply.sentences.size()
                        && (reply.audio.containsKey(next) || next >= VOICED_SENTENCES || reply.finished)) {
                        sentence = reply.sentences.get(next);
                        voiced = reply.audio.get(next);
                        break;
                    }
                    if (reply.finished && !reply.done) break;
                    reply.wait(200);
                }
                if (sentence == null) {
                    if (reply.done && plannedCount(reply) < reply.sentences.size()) shortened = true;
                    if (reply.error != null || (reply.finished && !reply.done)) {
                        String problem = reply.error != null ? reply.error : "The connection closed before the reply finished.";
                        Log.w("JarvisHandsFree", problem);
                        if (next == 0) say("Sorry, " + honorific() + ", I couldn't reach the server.");
                        return false;
                    }
                }
            }
            if (sentence == null) break;
            status.show("Speaking…");
            if (voiced != null && voiced.length > 0) play(voiced);
            else say(sentence);
            next++;
        }
        if (shortened) say("The rest is in the app.");

        synchronized (reply) {
            if (reply.handedOff) {
                handedOff = true;
                return false;
            }
        }
        boolean needsApp = false;
        for (int i = 0; i < reply.actions.length(); i++) {
            JSONObject action = reply.actions.optJSONObject(i);
            if (action == null || action.optBoolean("queued")) continue;
            String type = action.optString("type");
            if (type.equals("call_contact") || type.equals("ai_call") || type.equals("open_url")) needsApp = true;
        }
        if (needsApp) say("Tap the notification and I'll finish that in the app, " + honorific() + ".");
        return needsApp;
    }

    /** How many sentences are read out: all of a short reply, the first two of a long one (as spokenParts in app.js). */
    private static int plannedCount(Reply reply) {
        int count = reply.sentences.size();
        return count > VOICED_SENTENCES && reply.content.length() >= 250 ? 2 : count;
    }

    private void stream(String text, Reply reply) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(prefs.getString("server", "") + "/api/chat").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("Authorization", "Bearer " + prefs.getString("token", ""));
            JSONObject body = new JSONObject()
                .put("text", text)
                .put("tz", TimeZone.getDefault().getID())
                .put("voice", true);
            boolean isLocked = locked(context);
            if (isLocked) body.put("locked", true);
            String inbox = isLocked ? null : JarvisNotifications.summaryForAi(context);
            if (inbox != null) body.put("notifications", inbox);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code == 401) {
                prefs.edit().remove("token").apply();
                throw new IllegalStateException("signed out");
            }
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            try (BufferedReader in = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String event = null;
                StringBuilder data = new StringBuilder();
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith("event: ")) event = line.substring(7);
                    else if (line.startsWith("data: ")) data.append(line.substring(6));
                    else if (line.isEmpty() && event != null) {
                        handle(reply, event, new JSONObject(data.length() > 0 ? data.toString() : "{}"), this);
                        event = null;
                        data.setLength(0);
                    }
                }
            }
        } catch (Exception e) {
            synchronized (reply) {
                if (!reply.done) reply.error = e.getMessage();
            }
        } finally {
            if (connection != null) connection.disconnect();
            synchronized (reply) {
                reply.finished = true;
                reply.notifyAll();
            }
        }
    }

    private static void handle(Reply reply, String event, JSONObject data, HandsFree self) throws Exception {
        Context context = self.context;
        String honorific = self.honorific();
        if (event.equals("done")) {
            // Torch, volume, replies and the like happen here, before the reply is read out: if one can't be done,
            // what went wrong is said instead.
            JSONArray actions = data.optJSONArray("actions");
            JSONObject message = data.optJSONObject("reply");
            for (int i = 0; actions != null && message != null && i < actions.length(); i++) {
                JSONObject action = actions.optJSONObject(i);
                if (action == null || !PhoneControl.isPhoneAction(action)) continue;
                // A reply is read back and only sent on a clear yes.
                if (action.optString("type").equals("reply_message") && !locked(context)) {
                    String answer = self.ask("Reply to " + action.optString("to") + ": " + action.optString("text") + ". Shall I send it?");
                    if (!AgentRules.saidYes(answer)) {
                        message.put("content", "All right, I haven't sent it, " + honorific + ".");
                        continue;
                    }
                    action.put("confirmed", true);
                }
                String problem = PhoneControl.perform(context, action, honorific);
                if (problem != null) message.put("content", problem);
                else if (action.optString("type").equals("phone_task")) {
                    synchronized (reply) { reply.handedOff = true; }
                }
            }
        }
        synchronized (reply) {
            switch (event) {
                case "sentence":
                    reply.sentences.add(data.optString("text"));
                    break;
                case "audio":
                    String mp3 = data.isNull("audio") ? null : data.optString("audio", null);
                    reply.audio.put(data.optInt("index"), mp3 == null ? new byte[0] : Base64.decode(mp3, Base64.DEFAULT));
                    break;
                case "done":
                    JSONObject message = data.optJSONObject("reply");
                    reply.content = message == null ? "" : message.optString("content");
                    JSONArray actions = data.optJSONArray("actions");
                    if (actions != null) reply.actions = actions;
                    // A reply that was never streamed sentence by sentence is read out whole.
                    if (reply.sentences.isEmpty() && !reply.content.isEmpty()) reply.sentences.add(reply.content);
                    reply.done = true;
                    break;
                case "error":
                    reply.error = data.optString("error", "error");
                    break;
                default:
                    break;
            }
            reply.notifyAll();
        }
    }

    // ───────── speaking ─────────

    private void takeFocus() {
        if (focus != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes())
            .build();
        context.getSystemService(AudioManager.class).requestAudioFocus(focus);
    }

    private void abandonFocus() {
        if (focus != null) context.getSystemService(AudioManager.class).abandonAudioFocusRequest(focus);
        focus = null;
    }

    /** In call mode, Jarvis's voice goes to the headphones as call audio; otherwise wherever sound normally goes. */
    private AudioAttributes attributes() {
        return new AudioAttributes.Builder()
            .setUsage(callMode ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    }

    /** Plays the server's MP3 of Jarvis's voice, and waits until it finishes. */
    private void play(byte[] mp3) throws Exception {
        takeFocus();
        File file = new File(context.getCacheDir(), "hands-free.mp3");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(mp3);
        }
        CountDownLatch finished = new CountDownLatch(1);
        MediaPlayer player = new MediaPlayer();
        try {
            player.setAudioAttributes(attributes());
            player.setDataSource(file.getPath());
            player.setOnCompletionListener(p -> finished.countDown());
            player.setOnErrorListener((p, what, extra) -> { finished.countDown(); return true; });
            player.prepare();
            player.start();
            finished.await(Math.max(5000, player.getDuration() + 3000), TimeUnit.MILLISECONDS);
        } finally {
            player.release();
        }
    }

    /** The phone's own voice, for short things the server didn't voice. */
    private void say(String text) throws InterruptedException {
        takeFocus();
        if (!ttsReady) {
            CountDownLatch started = new CountDownLatch(1);
            main.post(() -> tts = new TextToSpeech(context, code -> {
                ttsReady = code == TextToSpeech.SUCCESS;
                if (ttsReady) {
                    tts.setLanguage(Locale.UK);
                    tts.setAudioAttributes(attributes());
                }
                started.countDown();
            }));
            started.await(5, TimeUnit.SECONDS);
            if (!ttsReady) return;
        }
        CountDownLatch finished = new CountDownLatch(1);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { finished.countDown(); }
            @Override public void onError(String id) { finished.countDown(); }
        });
        tts.setSpeechRate(prefs.getFloat("rate", 1f));
        tts.setPitch(prefs.getFloat("pitch", 1f));
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString());
        finished.await(3000 + text.length() * 100L, TimeUnit.MILLISECONDS);
    }
}
