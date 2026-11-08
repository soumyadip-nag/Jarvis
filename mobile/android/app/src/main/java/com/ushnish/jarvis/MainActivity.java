package com.ushnish.jarvis;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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

    /** "Hey Jarvis" can come with the phone locked: show over the lock screen, only for that conversation. */
    private void showForWake(Intent intent) {
        if (intent == null || !intent.getBooleanExtra("wake", false)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
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
