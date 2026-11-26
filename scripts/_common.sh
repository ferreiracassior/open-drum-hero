# Functions shared by the Linux scripts (the same steps as _common.ps1, which the Windows scripts use).
# Sourced by the other scripts: . "$(dirname "$0")/_common.sh"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
DESKTOP_DIR="$ROOT/desktop"
RELEASE="$ROOT/release"

cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

assert_node() {
  command -v npm >/dev/null 2>&1 ||
    die "Node.js not found. Install Node LTS (e.g. 'sudo pacman -S nodejs-lts-jod npm' or 'sudo apt install nodejs npm') and run again."
}

# npm install only when needed: first time or when package.json changed
install_node_deps() {
  local dir="$1" lock="$1/node_modules/.package-lock.json"
  if [ ! -f "$lock" ] || [ "$dir/package.json" -nt "$lock" ]; then
    cyan "Installing dependencies in $dir ..."
    (cd "$dir" && npm install --no-audit --no-fund) || die "npm install failed in $dir"
  fi
}

# Version of the AppImage, exe and apk: version.json at the root is the only place to change it
# (same rules as Update-Version in _common.ps1: "autoBump": true adds 1 to the last number and to "build").
# The version is then written to desktop/package.json, frontend/package.json and frontend/android/app/build.gradle.
update_version() {
  ROOT="$ROOT" node -e '
    const fs = require("fs"), path = require("path"), root = process.env.ROOT;
    const file = path.join(root, "version.json");
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v.autoBump) {
      const parts = v.version.split(".");
      parts[2] = String(Number(parts[2]) + 1);
      v.version = parts.join(".");
      v.build = Number(v.build) + 1;
      fs.writeFileSync(file, `{\n  "version": "${v.version}",\n  "build": ${v.build},\n  "autoBump": true\n}\n`);
    }
    for (const pkg of ["desktop/package.json", "frontend/package.json"].map(p => path.join(root, p))) {
      const text = fs.readFileSync(pkg, "utf8");
      fs.writeFileSync(pkg, text.replace(/"version":\s*"[^"]*"/, `"version": "${v.version}"`));
    }
    const gradle = path.join(root, "frontend/android/app/build.gradle");
    fs.writeFileSync(gradle, fs.readFileSync(gradle, "utf8")
      .replace(/versionCode\s+\d+/, `versionCode ${v.build}`)
      .replace(/versionName\s+"[^"]*"/, `versionName "${v.version}"`));
    console.log(`\x1b[36mVersion ${v.version} (build ${v.build})\x1b[0m`);
  '
}

app_version() { ROOT="$ROOT" node -p 'require(process.env.ROOT + "/version.json").version'; }

# Builds the app (the SAME one for the AppImage, the exe and the apk)
build_app() {
  update_version
  install_node_deps "$FRONTEND"
  cyan "Building the app..."
  (cd "$FRONTEND" && npx ng build) || die "the app build failed"
  # the license and the third-party notices go inside the AppImage, the exe and the apk too
  local out="$FRONTEND/dist/frontend/browser"
  cp -f "$ROOT/LICENSE" "$out/LICENSE.txt"
  cp -f "$ROOT/THIRD_PARTY_NOTICES.md" "$out/third-party-notices.txt"
}

get_adb() {
  if command -v adb >/dev/null 2>&1; then command -v adb; return; fi
  local sdk; sdk="$(find_android_sdk)" || return 1
  [ -x "$sdk/platform-tools/adb" ] && echo "$sdk/platform-tools/adb"
}

# Java 21 for Gradle: the one that comes with Android Studio (jbr) works
find_java() {
  local c
  for c in "${JAVA_HOME:-}" /opt/android-studio/jbr "$HOME/android-studio/jbr" /usr/share/android-studio/jbr \
           "$HOME/.local/share/JetBrains/Toolbox/apps/android-studio/jbr" /snap/android-studio/current/jbr \
           /usr/lib/jvm/java-2[1-9]-* /usr/lib/jvm/jdk-2[1-9]*; do
    if [ -n "$c" ] && [ -x "$c/bin/java" ]; then echo "$c"; return; fi
  done
  return 1
}

find_android_sdk() {
  local c
  for c in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" /opt/android-sdk; do
    if [ -n "$c" ] && [ -d "$c/platform-tools" ]; then echo "$c"; return; fi
  done
  return 1
}

# Opens a folder in the file manager (selecting the file when the file manager supports it)
show_in_folder() {
  local target="$1"
  if [ -f "$target" ] && command -v dbus-send >/dev/null 2>&1 &&
     dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 \
       org.freedesktop.FileManager1.ShowItems array:string:"file://$target" string:"" >/dev/null 2>&1; then
    return
  fi
  [ -f "$target" ] && target="$(dirname "$target")"
  command -v xdg-open >/dev/null 2>&1 && (xdg-open "$target" >/dev/null 2>&1 &) || true
}
