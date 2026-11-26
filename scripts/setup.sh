#!/usr/bin/env bash
# Installs the (Node) dependencies of the app and the desktop package, runs the tests and checks what the apk needs.
# (Linux version of setup.ps1.)
. "$(dirname "$0")/_common.sh"
assert_node
install_node_deps "$FRONTEND"
install_node_deps "$DESKTOP_DIR"
(cd "$FRONTEND" && npx ng test --watch=false)
if ! find_java >/dev/null || ! find_android_sdk >/dev/null; then
  warn "To build the apk, install Android Studio (it brings Java and the Android SDK) and open it once."
fi
echo
green "Done. Use the 'Build AppImage' and 'Build apk' shortcuts."
