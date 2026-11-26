#!/usr/bin/env bash
# Creates Linux shortcuts (.desktop) for the OpenDrumHero scripts in the shortcuts/ folder
# (and, if you want, also on the Desktop). Linux version of create-shortcuts.ps1.
# Usage: scripts/create-shortcuts.sh [--desktop]
. "$(dirname "$0")/_common.sh"
out="$ROOT/shortcuts"
icon="$DESKTOP_DIR/icon.png"
runner="$ROOT/scripts/run-in-terminal.sh"
desk="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -n "$desk" ] && [ "$desk" != "$HOME" ] || desk="$HOME/Desktop"
chmod +x "$ROOT"/scripts/*.sh

# Quotes an argument for the Exec line of a .desktop file
exec_arg() {
  local s="$1"
  s="${s//\\/\\\\\\\\}"; s="${s//\"/\\\\\"}"; s="${s//\`/\\\\\`}"; s="${s//\$/\\\\\$}"
  printf '"%s"' "$s"
}

# Lets the file managers start the shortcut (KDE needs it executable; GNOME also needs it "trusted")
trust() {
  chmod +x "$1"
  command -v gio >/dev/null 2>&1 && gio set "$1" metadata::trusted true 2>/dev/null || true
}

made=()
# file name, shortcut name, script, description
write_item() {
  local file="$out/$1.desktop"
  cat > "$file" <<EOF
[Desktop Entry]
Type=Application
Name=$2
Comment=$4
Exec=$(exec_arg "$runner") $(exec_arg "$3")
Path=$ROOT
Icon=$icon
Terminal=true
Categories=Development;
EOF
  trust "$file"
  made+=("$file")
}

write_item "OpenDrumHero - Build AppImage (Linux)" "OpenDrumHero - Build AppImage (Linux)" build-appimage.sh \
  "Builds release/OpenDrumHero-x.AppImage with the current app"
write_item "OpenDrumHero - Build apk (Android) and install on connected phone" \
  "OpenDrumHero - Build apk (Android) and install on connected phone" build-apk.sh \
  "Builds release/OpenDrumHero-x.apk (Android 13+). If the phone is on the USB cable with USB debugging on, it also installs it"
write_item "OpenDrumHero - Install dependencies" "OpenDrumHero - Install dependencies" setup.sh \
  "Installs/updates the dependencies and runs the tests"
write_item "OpenDrumHero - Test in browser" "OpenDrumHero - Test in browser" dev.sh \
  "Opens the app in the browser for development"

# Shortcut to the folder with the built AppImage, exe and apk
mkdir -p "$RELEASE"
file="$out/OpenDrumHero - Installers folder.desktop"
cat > "$file" <<EOF
[Desktop Entry]
Type=Application
Name=OpenDrumHero - Installers folder
Comment=Opens the release/ folder with the AppImage, the exe and the apk
Exec=xdg-open $(exec_arg "$RELEASE")
Icon=$icon
Terminal=false
EOF
trust "$file"
made+=("$file")

green "Shortcuts created in $out"
for f in "${made[@]}"; do echo "  - $(basename "$f")"; done

copy_desktop=0
[ "${1:-}" = "--desktop" ] && copy_desktop=1
if [ $copy_desktop -eq 0 ] && [ -t 0 ]; then
  read -r -p "Also copy them to the Desktop? (y/N) " ans
  [[ "$ans" =~ ^[yYsS] ]] && copy_desktop=1
fi
if [ $copy_desktop -eq 1 ]; then
  mkdir -p "$desk"
  for f in "${made[@]}"; do cp -f "$f" "$desk/"; trust "$desk/$(basename "$f")"; done
  green "Copied to $desk"
fi
