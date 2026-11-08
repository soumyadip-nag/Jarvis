package com.ushnish.jarvis;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Jarvis's hands inside other apps, with Android's Accessibility access (the user turns it on): it reads what's on
 * the screen as text and taps, types and scrolls. It does nothing by itself; PhoneAgent drives it one step at a time.
 */
public class JarvisAccessibility extends AccessibilityService {

    static volatile JarvisAccessibility instance;
    private static final int MAX_ITEMS = 120;
    private static final int MAX_CHARS = 5000;

    static boolean allowed(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        return enabled != null && enabled.contains(new ComponentName(context, JarvisAccessibility.class).flattenToString());
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override
    public void onInterrupt() { }

    // ───────── reading the screen ─────────

    /** The screen as numbered lines the AI can refer to, and the items those numbers mean. */
    static final class Screen {
        String pkg = "";
        String appName = "";
        final StringBuilder text = new StringBuilder();
        final List<AccessibilityNodeInfo> items = new ArrayList<>();
    }

    Screen read() {
        Screen screen = new Screen();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            screen.text.append("(the screen can't be read right now)");
            return screen;
        }
        screen.pkg = root.getPackageName() == null ? "" : root.getPackageName().toString();
        screen.appName = appName(screen.pkg);
        walk(root, screen);
        if (screen.items.isEmpty()) screen.text.append("(nothing readable on screen)");
        return screen;
    }

    private void walk(AccessibilityNodeInfo node, Screen screen) {
        if (node == null || screen.items.size() >= MAX_ITEMS || screen.text.length() >= MAX_CHARS) return;
        if (!node.isVisibleToUser()) return;
        String line = describe(node);
        if (line != null) {
            screen.text.append('[').append(screen.items.size()).append("] ").append(line).append('\n');
            screen.items.add(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), screen);
    }

    /** One line for an item worth showing, or null: `button "Send"`, `field "Message" = "hi"`, `text "Rahul"`. */
    private static String describe(AccessibilityNodeInfo node) {
        String label = label(node);
        boolean editable = node.isEditable();
        boolean acts = node.isClickable() || node.isLongClickable() || node.isCheckable() || editable || node.isScrollable();
        if (!acts && (label.isEmpty() || !hasWords(node))) return null;
        String cls = node.getClassName() == null ? "" : node.getClassName().toString();
        String role = editable ? "field"
            : node.isCheckable() ? "toggle"
            : cls.endsWith("Button") ? "button"
            : node.isScrollable() ? "list"
            : cls.endsWith("ImageView") ? "image"
            : node.isClickable() ? "item"
            : "text";
        StringBuilder out = new StringBuilder(role);
        if (node.isPassword()) {
            out.append(" (password, hidden)");
            return out.toString();
        }
        if (!label.isEmpty()) out.append(" \"").append(trim(label, 120)).append('"');
        if (editable && node.getText() != null && node.getText().length() > 0) {
            CharSequence hint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? node.getHintText() : null;
            boolean showingHint = hint != null && hint.toString().equals(node.getText().toString());
            if (!showingHint) out.append(" = \"").append(trim(node.getText().toString(), 200)).append('"');
        }
        if (node.isCheckable()) out.append(node.isChecked() ? " (on)" : " (off)");
        if (node.isSelected()) out.append(" (selected)");
        if (!node.isEnabled()) out.append(" (disabled)");
        return out.toString();
    }

    /** What an item says: its text, else its description, else its hint, else the end of its id. */
    static String label(AccessibilityNodeInfo node) {
        if (node.isPassword()) return "";
        CharSequence hint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? node.getHintText() : null;
        // A text field is named by its hint or description; what's typed in it is shown separately.
        CharSequence[] options = node.isEditable()
            ? new CharSequence[] { hint, node.getContentDescription() }
            : new CharSequence[] { node.getText(), node.getContentDescription(), hint };
        for (CharSequence option : options) {
            if (option != null && option.toString().trim().length() > 0) return option.toString().trim().replaceAll("\\s+", " ");
        }
        String id = node.getViewIdResourceName();
        return id == null ? "" : id.substring(id.lastIndexOf('/') + 1).replace('_', ' ');
    }

    /** Whether an item shows or describes something itself, rather than only having a layout id. */
    private static boolean hasWords(AccessibilityNodeInfo node) {
        return (node.getText() != null && node.getText().toString().trim().length() > 0)
            || (node.getContentDescription() != null && node.getContentDescription().toString().trim().length() > 0);
    }

    /** An item's label with everything inside it, for deciding whether a tap is risky (a Send icon in a frame...). */
    static String fullLabel(AccessibilityNodeInfo node) {
        StringBuilder out = new StringBuilder(label(node));
        String id = node.getViewIdResourceName();
        if (id != null) out.append(' ').append(id.substring(id.lastIndexOf('/') + 1).replace('_', ' '));
        for (int i = 0; i < node.getChildCount() && out.length() < 300; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) out.append(' ').append(fullLabel(child));
        }
        return out.toString();
    }

    private static String trim(String text, int max) {
        String t = text.replace('\n', ' ').replace('"', '\'');
        return t.length() > max ? t.substring(0, max) + "…" : t;
    }

    String appName(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    // ───────── acting ─────────

    /** The item a tap should go to: the item itself if clickable, else the nearest clickable item around it. */
    static AccessibilityNodeInfo clickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo at = node;
        for (int i = 0; at != null && i < 6; i++, at = at.getParent()) if (at.isClickable()) return at;
        return node;
    }

    /** Carries out one step. Returns what happened, for the AI's next turn. */
    String act(JSONObject step, Screen screen) throws InterruptedException {
        String action = step.optString("action");
        AccessibilityNodeInfo node = null;
        if (step.has("id")) {
            int id = step.optInt("id", -1);
            if (id < 0 || id >= screen.items.size()) return "no item [" + id + "] on this screen";
            node = screen.items.get(id);
        }
        switch (action) {
            case "open_app":
                return openApp(step.optString("name"));
            case "tap":
                if (node == null) return "tap needs an id";
                if (clickable(node).performAction(AccessibilityNodeInfo.ACTION_CLICK)) return "tapped";
                return gestureTap(node, 60) ? "tapped (by touch)" : "the tap didn't work";
            case "long_press":
                if (node == null) return "long_press needs an id";
                if (clickable(node).performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) return "long-pressed";
                return gestureTap(node, 800) ? "long-pressed (by touch)" : "the long press didn't work";
            case "type": {
                AccessibilityNodeInfo field = node != null ? editableIn(node) : focusedField();
                if (field == null) return "there's no text field there";
                field.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, step.optString("text"));
                return field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) ? "typed" : "typing didn't work";
            }
            case "submit": {
                AccessibilityNodeInfo field = node != null ? editableIn(node) : focusedField();
                if (field == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "there's no field to submit";
                return field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId()) ? "submitted" : "submitting didn't work";
            }
            case "scroll": {
                boolean down = !"up".equals(step.optString("direction", "down"));
                AccessibilityNodeInfo list = node != null ? scrollableAround(node) : firstScrollable(getRootInActiveWindow());
                if (list != null && list.performAction(down ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return "scrolled";
                return swipe(down) ? "scrolled (by swipe)" : "couldn't scroll";
            }
            case "back":
                return performGlobalAction(GLOBAL_ACTION_BACK) ? "went back" : "couldn't go back";
            case "home":
                return performGlobalAction(GLOBAL_ACTION_HOME) ? "went to the home screen" : "couldn't go home";
            case "wait":
                Thread.sleep(2000);
                return "waited";
            default:
                return "unknown action " + action;
        }
    }

    private String openApp(String name) {
        PackageManager pm = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        ResolveInfo best = null;
        int bestFit = 0;
        for (ResolveInfo app : pm.queryIntentActivities(launcher, 0)) {
            String label = app.loadLabel(pm).toString();
            int fit = Inbox.fit(label, name);
            if (fit == 0 && Inbox.simple(label).replace(" ", "").equals(Inbox.simple(name).replace(" ", ""))) fit = 3;
            if (fit > bestFit) {
                bestFit = fit;
                best = app;
            }
        }
        if (best == null) return "no app called \"" + name + "\" is installed";
        String pkg = best.activityInfo.packageName;
        String label = best.loadLabel(pm).toString();
        if (AgentRules.isBlocked(pkg, label)) return "BLOCKED: " + label + " is a money or password app";
        Intent open = pm.getLaunchIntentForPackage(pkg);
        if (open == null) return "couldn't open " + label;
        startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
        return "opened " + label;
    }

    private static AccessibilityNodeInfo editableIn(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = editableIn(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private AccessibilityNodeInfo focusedField() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo focused = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return focused != null && focused.isEditable() ? focused : editableIn(root);
    }

    private static AccessibilityNodeInfo scrollableAround(AccessibilityNodeInfo node) {
        for (AccessibilityNodeInfo at = node; at != null; at = at.getParent()) if (at.isScrollable()) return at;
        return null;
    }

    private static AccessibilityNodeInfo firstScrollable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isScrollable() && node.isVisibleToUser()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = firstScrollable(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private boolean gestureTap(AccessibilityNodeInfo node, long ms) throws InterruptedException {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (bounds.isEmpty()) return false;
        Path path = new Path();
        path.moveTo(bounds.exactCenterX(), bounds.exactCenterY());
        return gesture(path, ms);
    }

    private boolean swipe(boolean down) throws InterruptedException {
        int w = getResources().getDisplayMetrics().widthPixels;
        int h = getResources().getDisplayMetrics().heightPixels;
        Path path = new Path();
        path.moveTo(w / 2f, down ? h * 0.7f : h * 0.3f);
        path.lineTo(w / 2f, down ? h * 0.3f : h * 0.7f);
        return gesture(path, 350);
    }

    private boolean gesture(Path path, long ms) throws InterruptedException {
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, ms))
            .build();
        final boolean[] done = { false };
        final java.util.concurrent.CountDownLatch finished = new java.util.concurrent.CountDownLatch(1);
        boolean sent = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { done[0] = true; finished.countDown(); }
            @Override public void onCancelled(GestureDescription g) { finished.countDown(); }
        }, null);
        if (!sent) return false;
        finished.await(ms + 2000, java.util.concurrent.TimeUnit.MILLISECONDS);
        return done[0];
    }

    /** What the user sees, for the risk check of a step: the label of what it would tap, in the app it's in. */
    static String riskLabel(JSONObject step, Screen screen) {
        String action = step.optString("action");
        int id = step.optInt("id", -1);
        if ((action.equals("tap") || action.equals("long_press")) && id >= 0 && id < screen.items.size()) {
            return fullLabel(clickable(screen.items.get(id))).toLowerCase(Locale.ROOT);
        }
        return "";
    }
}
