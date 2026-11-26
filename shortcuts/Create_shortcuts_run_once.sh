#!/usr/bin/env bash
# Linux: run once (double-click > Run, or from a terminal). Creates the OpenDrumHero shortcuts in this folder
# (and optionally on the Desktop). Same as "Create shortcuts (double-click once).cmd" on Windows.
here="$(cd "$(dirname "$0")" && pwd)"
# started from the file manager (no terminal): open itself in a terminal, so the question can be answered
if [ ! -t 0 ] && [ -z "${ODH_IN_TERMINAL:-}" ]; then
  export ODH_IN_TERMINAL=1
  for t in konsole gnome-terminal kgx ptyxis xfce4-terminal mate-terminal tilix alacritty wezterm kitty foot xterm; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$t" in
      gnome-terminal|ptyxis|tilix) exec "$t" -- bash "$here/$(basename "$0")" ;;
      kitty|foot) exec "$t" bash "$here/$(basename "$0")" ;;
      wezterm) exec "$t" start -- bash "$here/$(basename "$0")" ;;
      *) exec "$t" -e bash "$here/$(basename "$0")" ;;
    esac
  done
fi
bash "$here/../scripts/create-shortcuts.sh" "$@"
echo
read -r -p "Press Enter to close..." _
