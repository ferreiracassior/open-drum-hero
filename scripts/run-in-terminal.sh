#!/usr/bin/env bash
# Used by the Linux shortcuts (.desktop): runs one of the scripts and keeps the terminal open at the end, so the
# output can be read (like "-NoExit" in the Windows shortcuts).
cd "$(dirname "$0")/.."
bash "scripts/$1"
status=$?
echo
if [ $status -eq 0 ]; then echo "Finished."; else printf '\033[31mFailed (exit code %s).\033[0m\n' "$status"; fi
read -r -p "Press Enter to close..." _
