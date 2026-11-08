#!/bin/bash
# Installs the APK on the emulator, adds sample contacts and exercises the native plugin.
# Results land in mobile/ci-out for the release. Uses a sample phone line; it never reaches a real number.
OUT=mobile/ci-out
PKG=com.ushnish.jarvis
exec > >(tee "$OUT/smoke.log") 2>&1

# A real upgrade over the last published build: this is what the update button relies on.
curl -fsSL -o "$RUNNER_TEMP/previous.apk" https://github.com/RaGnaRoK260404/jarvis-updates/releases/download/apk-latest/jarvis.apk   || curl -fsSL -o "$RUNNER_TEMP/previous.apk" https://github.com/RaGnaRoK260404/Jarvis/releases/download/apk-latest/jarvis.apk
adb install "$RUNNER_TEMP/previous.apk"
if adb install -r "$OUT/jarvis.apk"; then
  echo "UPGRADE OVER PREVIOUS BUILD: OK"
else
  echo "UPGRADE OVER PREVIOUS BUILD: FAILED"
  adb uninstall "$PKG"
  adb install "$OUT/jarvis.apk"
fi

add_contact() { # name, number, mime type of the number row, account
  adb shell content insert --uri content://com.android.contacts/raw_contacts \
    --bind account_type:s:"$4" --bind account_name:s:sample
  local id
  id=$(adb shell content query --uri content://com.android.contacts/raw_contacts --projection _id | tail -1 | sed -E 's/.*_id=([0-9]+).*/\1/' | tr -d '\r')
  adb shell "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'$1'"
  adb shell "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:$id --bind mimetype:s:$3 --bind data1:s:'$2'"
}
add_contact "Ravi Kumar" "+919800000001" "vnd.android.cursor.item/phone_v2" "com.google"
add_contact "Whatsapp Only" "919800000002@s.whatsapp.net" "vnd.android.cursor.item/vnd.com.whatsapp.profile" "com.whatsapp"

adb shell appops set "$PKG" REQUEST_INSTALL_PACKAGES allow
for p in READ_CONTACTS CALL_PHONE RECORD_AUDIO POST_NOTIFICATIONS; do adb shell pm grant "$PKG" "android.permission.$p"; done

adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
sleep 30
adb exec-out screencap -p > "$OUT/screen-start.png"

PID=$(adb shell pidof "$PKG" | tr -d '\r')
echo "app pid: $PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_$PID"
node mobile/ci/smoke.mjs "$OUT"

sleep 5
adb exec-out screencap -p > "$OUT/screen-after-call.png"
adb shell dumpsys telephony.registry | grep -m2 -E "mCallState|mCallIncomingNumber"
sleep 15
adb exec-out screencap -p > "$OUT/screen-update.png"
adb logcat -d > "$OUT/logcat.txt"
exit 0
