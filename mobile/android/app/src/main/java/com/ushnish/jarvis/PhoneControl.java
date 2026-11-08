package com.ushnish.jarvis;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.SystemClock;
import android.provider.AlarmClock;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.view.KeyEvent;

import org.json.JSONObject;

/**
 * The phone's settings by voice ("torch on", "volume to 40", "do not disturb", "next song", "alarm for 6:30").
 * Comes from the server's phone_control tool. Returns null when done, or what to say instead.
 */
final class PhoneControl {

    private PhoneControl() { }

    /** The phone actions the server can hand back: phone_control and reply_message. Null when done, or what to say. */
    static String perform(Context context, JSONObject action, String honorific) {
        String type = action.optString("type");
        // On a locked phone, whoever is speaking may not be the user: no messages.
        if (type.equals("reply_message") && HandsFree.locked(context)) {
            return "Please unlock your phone first, " + honorific + ", and ask me again.";
        }
        if (type.equals("reply_message") && !action.optBoolean("confirmed")) {
            return "I need your go-ahead before sending that, " + honorific + ".";
        }
        switch (type) {
            case "phone_control":
                return run(context, action, honorific);
            case "reply_message": {
                JarvisNotifications listener = JarvisNotifications.instance;
                if (listener == null) {
                    return "To reply to messages I need notification access, " + honorific + ". You'll find it in my settings.";
                }
                return listener.reply(action.optString("to"), action.optString("text"), action.optString("app"), honorific);
            }
            default:
                return null;
        }
    }

    static boolean isPhoneAction(JSONObject action) {
        String type = action.optString("type");
        return !action.optBoolean("queued") && (type.equals("phone_control") || type.equals("reply_message"));
    }

    static String run(Context context, JSONObject action, String honorific) {
        String what = action.optString("control");
        AudioManager audio = context.getSystemService(AudioManager.class);
        try {
            switch (what) {
                case "torch_on":
                case "torch_off":
                    return torch(context, what.equals("torch_on"), honorific);
                case "volume": {
                    int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                    int level = Math.max(0, Math.min(100, action.optInt("level", 50)));
                    audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(level * max / 100f), 0);
                    return null;
                }
                case "volume_up":
                case "volume_down":
                    for (int i = 0; i < 3; i++) {
                        audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                            what.equals("volume_up") ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, 0);
                    }
                    return null;
                case "mute":
                case "unmute":
                    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, what.equals("mute") ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, 0);
                    return null;
                case "dnd_on":
                case "dnd_off":
                    return doNotDisturb(context, what.equals("dnd_on"), honorific);
                case "play":
                    return media(audio, KeyEvent.KEYCODE_MEDIA_PLAY);
                case "pause":
                    return media(audio, KeyEvent.KEYCODE_MEDIA_PAUSE);
                case "next":
                    return media(audio, KeyEvent.KEYCODE_MEDIA_NEXT);
                case "previous":
                    return media(audio, KeyEvent.KEYCODE_MEDIA_PREVIOUS);
                case "alarm": {
                    int hour = action.optInt("hour", -1);
                    int minute = action.optInt("minute", 0);
                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "What time should the alarm be, " + honorific + "?";
                    Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
                        .putExtra(AlarmClock.EXTRA_HOUR, hour)
                        .putExtra(AlarmClock.EXTRA_MINUTES, minute)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
                    if (!action.optString("name").isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, action.optString("name"));
                    return open(context, intent, honorific);
                }
                case "timer": {
                    int seconds = action.optInt("seconds", 0);
                    if (seconds <= 0 || seconds > 24 * 3600) return "How long should the timer be, " + honorific + "?";
                    Intent intent = new Intent(AlarmClock.ACTION_SET_TIMER)
                        .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
                    if (!action.optString("name").isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, action.optString("name"));
                    return open(context, intent, honorific);
                }
                case "wifi":
                    // Android doesn't let apps switch Wi-Fi or Bluetooth themselves: it shows its own switch instead.
                    return open(context, new Intent(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? Settings.Panel.ACTION_WIFI : Settings.ACTION_WIFI_SETTINGS), honorific);
                case "bluetooth":
                    return open(context, new Intent(Settings.ACTION_BLUETOOTH_SETTINGS), honorific);
                default:
                    return "I can't do that on the phone yet, " + honorific + ".";
            }
        } catch (SecurityException e) {
            return "Android didn't allow that, " + honorific + ".";
        }
    }

    private static String torch(Context context, boolean on, String honorific) {
        CameraManager cameras = context.getSystemService(CameraManager.class);
        try {
            for (String id : cameras.getCameraIdList()) {
                Boolean flash = cameras.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                if (Boolean.TRUE.equals(flash)) {
                    cameras.setTorchMode(id, on);
                    return null;
                }
            }
        } catch (CameraAccessException | IllegalArgumentException e) {
            return "The torch isn't available right now, " + honorific + ".";
        }
        return "This phone has no torch, " + honorific + ".";
    }

    private static String doNotDisturb(Context context, boolean on, String honorific) {
        int filter = on ? NotificationListenerService.INTERRUPTION_FILTER_PRIORITY : NotificationListenerService.INTERRUPTION_FILTER_ALL;
        JarvisNotifications listener = JarvisNotifications.instance;
        if (listener != null) {
            listener.requestInterruptionFilter(filter);
            return null;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.isNotificationPolicyAccessGranted()) {
            manager.setInterruptionFilter(on ? NotificationManager.INTERRUPTION_FILTER_PRIORITY : NotificationManager.INTERRUPTION_FILTER_ALL);
            return null;
        }
        return "For Do Not Disturb I need notification access, " + honorific + ". You'll find it in my settings.";
    }

    private static String media(AudioManager audio, int key) {
        long now = SystemClock.uptimeMillis();
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, key, 0));
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, key, 0));
        return null;
    }

    /** Alarms, timers and the Wi-Fi and Bluetooth switches are other apps' screens, which need Jarvis allowed to open things. */
    private static String open(Context context, Intent intent, String honorific) {
        if (!MainActivity.visible && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            return "With the app closed, I need \"Let Jarvis open apps\" turned on in my settings for that, " + honorific + ".";
        }
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return null;
        } catch (RuntimeException e) {
            return "Your phone has no app for that, " + honorific + ".";
        }
    }
}
