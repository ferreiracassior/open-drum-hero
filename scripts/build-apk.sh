#!/usr/bin/env bash
# Builds OpenDrumHero for Android 13+: release/OpenDrumHero-<version>.apk. If the phone is on the cable with
# USB debugging on, it also installs it there. (Linux version of build-apk.ps1.)
# Uses the same app as the AppImage and the exe: any interface/feature change applies to all of them.
# Needs Android Studio installed (it brings Java and the Android SDK).
. "$(dirname "$0")/_common.sh"
assert_node

java="$(find_java)" || die "Java 21 not found. Install Android Studio (it brings Java) and run again."
sdk="$(find_android_sdk)" || die "Android SDK not found. Open Android Studio once (it installs the SDK) and run again."
export JAVA_HOME="$java" ANDROID_HOME="$sdk"
echo "Java: $java"
echo "SDK:  $sdk"

build_app
cyan "Copying the app into the Android project..."
(cd "$FRONTEND" && npx cap sync android) || die "cap sync failed"

# accepts the SDK licenses (Gradle downloads whatever is missing)
sdkmanager="$(find "$sdk/cmdline-tools" -name sdkmanager -type f 2>/dev/null | head -n 1 || true)"
[ -n "$sdkmanager" ] && { yes | "$sdkmanager" --licenses >/dev/null 2>&1 || true; }

android="$FRONTEND/android"
echo "sdk.dir=$sdk" > "$android/local.properties"
chmod +x "$android/gradlew"
cyan "Building the apk (the first time downloads Gradle, it takes a few minutes)..."
(cd "$android" && ./gradlew assembleDebug) || die "the apk build failed"

mkdir -p "$RELEASE"
apk="$RELEASE/OpenDrumHero-$(app_version).apk"
cp -f "$android/app/build/outputs/apk/debug/app-debug.apk" "$apk"
echo
green "Done: $apk"

if adb="$(get_adb)"; then
  if "$adb" devices | grep -q $'\tdevice$'; then
    cyan "Installing on the connected phone..."
    "$adb" install -r "$apk"
  else
    echo "To install: plug the phone into the cable (USB debugging) and run again, or copy the apk to the phone."
  fi
fi
show_in_folder "$apk"
