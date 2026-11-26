#!/usr/bin/env bash
# Builds OpenDrumHero for Linux: release/OpenDrumHero-<version>.AppImage (a single file, no install needed).
# Uses the same app as the exe and the apk: any interface/feature change applies to all of them.
. "$(dirname "$0")/_common.sh"
assert_node
build_app

cyan "Copying the app into the Linux package..."
rm -rf "$DESKTOP_DIR/app"
cp -r "$FRONTEND/dist/frontend/browser" "$DESKTOP_DIR/app"

install_node_deps "$DESKTOP_DIR"
cyan "Building the AppImage (the first time downloads Electron, it takes a while)..."
(cd "$DESKTOP_DIR" && npx electron-builder --linux AppImage --x64 --publish never) || die "the AppImage build failed"

appimage="$(ls -t "$RELEASE"/OpenDrumHero-*.AppImage | head -n 1)"
chmod +x "$appimage"
echo
green "Done: $appimage"
echo "Plug the drum kit into the PC USB and open the AppImage. Library and settings are saved next to it, in config/ and library/."
show_in_folder "$appimage"
