#!/usr/bin/env bash
# Development: opens the app in the browser with auto reload (http://localhost:4200). (Linux version of dev.ps1.)
# The drum kit works through Chrome/Chromium/Brave Web MIDI; Songsterr only inside the AppImage/exe/apk.
. "$(dirname "$0")/_common.sh"
assert_node
install_node_deps "$FRONTEND"
cd "$FRONTEND"
npx ng serve --open
