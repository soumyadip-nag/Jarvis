package com.ushnish.jarvis;

import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.telecom.TelecomManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * What the Android WebView can't do by itself: read contacts, place calls, listen and speak.
 * Contacts are returned to the page on this phone only; the web app never uploads them.
 */
@CapacitorPlugin(
    name = "JarvisNative",
    permissions = {
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class JarvisNativePlugin extends Plugin {

    private static final String PHONE_TYPE = ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE;
    private static final String WHATSAPP_TYPE = "vnd.android.cursor.item/vnd.com.whatsapp.profile";
    private static final String WHATSAPP_ACCOUNT = "com.whatsapp";

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private SpeechRecognizer recognizer;
    private PluginCall speakingCall;

    // ───────── contacts ─────────

    @PluginMethod
    public void getContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPermission");
            return;
        }
        readContacts(call);
    }

    @PermissionCallback
    private void contactsPermission(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            readContacts(call);
        } else {
            call.reject("Contacts permission was denied.");
        }
    }

    /** Every contact with a number, including people the phone only knows through WhatsApp. */
    private void readContacts(PluginCall call) {
        new Thread(() -> {
            String[] projection = {
                ContactsContract.Data.CONTACT_ID,
                ContactsContract.Data.DISPLAY_NAME,
                ContactsContract.Data.MIMETYPE,
                ContactsContract.Data.DATA1,
                ContactsContract.RawContacts.ACCOUNT_TYPE_AND_DATA_SET,
            };
            String selection = ContactsContract.Data.MIMETYPE + " IN (?, ?)";
            String[] args = { PHONE_TYPE, WHATSAPP_TYPE };
            Map<Long, JSObject> byContact = new LinkedHashMap<>();
            try (Cursor c = getContext().getContentResolver().query(ContactsContract.Data.CONTENT_URI, projection, selection, args, null)) {
                while (c != null && c.moveToNext()) {
                    String name = c.getString(1);
                    String mimeType = c.getString(2);
                    String value = c.getString(3);
                    String account = c.getString(4);
                    if (name == null || value == null) continue;

                    boolean fromWhatsApp = WHATSAPP_TYPE.equals(mimeType) || (account != null && account.startsWith(WHATSAPP_ACCOUNT));
                    // WhatsApp stores the number as 919800000000@s.whatsapp.net
                    String number = WHATSAPP_TYPE.equals(mimeType) ? "+" + value.split("@")[0] : value;

                    JSObject contact = byContact.get(c.getLong(0));
                    if (contact == null) {
                        contact = new JSObject();
                        contact.put("name", name);
                        contact.put("tel", number);
                        contact.put("whatsapp", fromWhatsApp);
                        byContact.put(c.getLong(0), contact);
                    } else if (fromWhatsApp) {
                        contact.put("whatsapp", true);
                    } else {
                        contact.put("tel", number); // a saved phone number beats a WhatsApp one
                    }
                }
            } catch (Exception e) {
                call.reject("Couldn't read contacts: " + e.getMessage());
                return;
            }
            JSObject result = new JSObject();
            result.put("contacts", new JSArray(new ArrayList<>(byContact.values())));
            call.resolve(result);
        }).start();
    }

    // ───────── calling ─────────

    @PluginMethod
    public void call(PluginCall call) {
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            requestPermissionForAlias("phone", call, "phonePermission");
            return;
        }
        placeCall(call);
    }

    @PermissionCallback
    private void phonePermission(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            placeCall(call);
        } else {
            call.reject("Phone permission was denied.");
        }
    }

    private void placeCall(PluginCall call) {
        String number = call.getString("number", "");
        if (number == null || number.isEmpty()) {
            call.reject("No number given.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't place the call: " + e.getMessage());
        }
    }

    // ───────── call test ─────────

    /** See CallTestService. Only ever started from the test button in Settings, for a number typed there. */
    @PluginMethod
    public void startCallTest(PluginCall call) {
        requestPermissionForAliases(new String[] { "phone", "microphone", "notifications" }, call, "callTestPermissions");
    }

    @PermissionCallback
    private void callTestPermissions(PluginCall call) {
        if (getPermissionState("phone") != PermissionState.GRANTED || getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("The call test needs the Phone and Microphone permissions.");
            return;
        }
        String number = call.getString("number", "");
        if (number == null || number.isEmpty()) {
            call.reject("No number given.");
            return;
        }
        try {
            CallTestService.finished = call::resolve;
            Intent service = new Intent(getContext(), CallTestService.class).putExtra("message", call.getString("message", ""));
            ContextCompat.startForegroundService(getContext(), service);

            Intent dial = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)));
            dial.putExtra(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, true);
            getActivity().startActivity(dial);
        } catch (Exception e) {
            CallTestService.finished = null;
            call.reject("Couldn't start the call test: " + e.getMessage());
        }
    }

    // ───────── listening ─────────

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermission");
            return;
        }
        startListening(call);
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startListening(call);
        } else {
            call.reject("Microphone permission was denied.");
        }
    }

    private void startListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Speech recognition isn't available on this phone.");
                return;
            }
            releaseRecognizer();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onResults(Bundle results) {
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    JSObject out = new JSObject();
                    out.put("text", matches == null || matches.isEmpty() ? "" : matches.get(0));
                    call.resolve(out);
                    releaseLater();
                }
                @Override public void onError(int error) {
                    releaseLater();
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        JSObject out = new JSObject();
                        out.put("text", "");
                        call.resolve(out);
                    } else {
                        call.reject("Speech recognition error " + error);
                    }
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
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, call.getString("lang", "en-IN"));
            recognizer.startListening(intent);
        });
    }

    // Destroying a recogniser and creating another straight away makes the new one fail with
    // error 11, so release each one when it finishes, not when the next one starts.
    private void releaseLater() {
        getActivity().runOnUiThread(this::releaseRecognizer);
    }

    private void releaseRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    // ───────── speaking ─────────

    private void withTts(PluginCall call, Runnable action) {
        if (ttsReady) {
            action.run();
            return;
        }
        if (tts != null) tts.shutdown();
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) {
                call.reject("Text to speech isn't available on this phone.");
                return;
            }
            tts.setLanguage(Locale.UK);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { finishSpeaking(); }
                @Override public void onError(String id) { finishSpeaking(); }
                @Override public void onStop(String id, boolean interrupted) { finishSpeaking(); }
            });
            action.run();
        });
    }

    private void finishSpeaking() {
        if (speakingCall != null) {
            speakingCall.resolve();
            speakingCall = null;
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        withTts(call, () -> {
            finishSpeaking();
            String wanted = call.getString("voice");
            if (wanted != null && tts.getVoices() != null) {
                for (Voice voice : tts.getVoices()) {
                    if (wanted.equals(voice.getName())) {
                        tts.setVoice(voice);
                        break;
                    }
                }
            }
            tts.setSpeechRate(call.getFloat("rate", 1f));
            tts.setPitch(call.getFloat("pitch", 1f));
            speakingCall = call;
            int queued = tts.speak(call.getString("text", ""), TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString());
            if (queued != TextToSpeech.SUCCESS) finishSpeaking();
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        finishSpeaking();
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        withTts(call, () -> {
            JSArray list = new JSArray();
            if (tts.getVoices() != null) {
                for (Voice voice : tts.getVoices()) {
                    if (voice.isNetworkConnectionRequired()) continue;
                    JSObject item = new JSObject();
                    item.put("name", voice.getName());
                    item.put("lang", voice.getLocale().toLanguageTag());
                    list.put(item);
                }
            }
            JSObject out = new JSObject();
            out.put("voices", list);
            call.resolve(out);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        if (recognizer != null) recognizer.destroy();
    }
}
