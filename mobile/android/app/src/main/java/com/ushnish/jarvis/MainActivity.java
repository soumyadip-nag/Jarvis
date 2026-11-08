package com.ushnish.jarvis;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Whether the app is on screen: if so, it answers "Hey Jarvis" itself; if not, the service does. */
    static volatile boolean visible = false;

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JarvisNativePlugin.class);
        super.onCreate(savedInstanceState);
        showForWake(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        showForWake(intent);
    }

    /**
     * "Hey Jarvis" can come with the phone locked. The app (with the whole chat) is never shown over the lock screen:
     * the screen turns on and Android asks for the unlock first.
     */
    private void showForWake(Intent intent) {
        if (intent == null || !intent.getBooleanExtra("wake", false)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.KeyguardManager keyguard = getSystemService(android.app.KeyguardManager.class);
            if (keyguard != null && keyguard.isKeyguardLocked()) keyguard.requestDismissKeyguard(this, null);
        }
    }

    /** After the conversation, the lock screen protects the app again. */
    public void leaveLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }
}
