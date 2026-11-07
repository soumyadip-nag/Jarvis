# Jarvis for Android

A Capacitor shell that loads the live site and adds what a WebView can't do: reading contacts, placing calls,
listening, speaking and installing updates. See `android/app/src/main/java/com/ushnish/jarvis/`.

Changes to the web app in `cloud/` reach the app by themselves. Pushing changes in this folder makes GitHub
build a new APK, try it on an emulator and publish it to the `apk-latest` release, where the app's update
button finds it.

## Signing

Android only installs an update signed with the same key as the installed app. The key is stored in the
`JARVIS_KEYSTORE` repository secret as a base64 PKCS12 file (password `android`, alias `androiddebugkey`), and
it must never be committed. Builds stop if the secret is missing. If it is lost, everyone has to uninstall and reinstall once with a new key.
