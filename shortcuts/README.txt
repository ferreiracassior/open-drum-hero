OpenDrumHero shortcuts
===================

1. Windows: double-click "Create shortcuts (double-click once).cmd".
   Linux: run "Create_shortcuts_run_once.sh" (double-click > Run, or ./Create_shortcuts_run_once.sh).
   It creates the shortcuts here (.lnk on Windows, .desktop on Linux) and asks whether to copy them to the Desktop.

2. To build the game:
   - OpenDrumHero - Build exe (Windows)            [Windows only]
         creates release\OpenDrumHero-x.exe (a single file; just open it)
   - OpenDrumHero - Build AppImage (Linux)         [Linux only]
         creates release/OpenDrumHero-x.AppImage (a single file; just open it)
   - OpenDrumHero - Build apk (Android) and install on connected phone
         creates release\OpenDrumHero.apk (Android 13 or newer).
         WARNING: if the phone is plugged into the USB cable with "USB debugging" turned on
         (developer options), this shortcut ALSO INSTALLS the apk on it (it replaces the
         installed version and keeps your songs). Without the phone on the cable it only
         builds the file: copy the apk to the phone and install it.
   The exe, the AppImage and the apk are the SAME app: every change applies to both when you build again.

Others:
   - OpenDrumHero - Install dependencies ... first time, or after updating the code
   - OpenDrumHero - Test in browser ........ opens the app in the browser (development)
   - OpenDrumHero - Installers folder ...... opens the release\ folder with the exe/AppImage and the apk

Requirements: Node.js LTS (exe, AppImage and apk) and Android Studio (apk only; it brings Java and the SDK).

In the game: plug the drum kit into the PC's USB (exe/AppImage) or into the phone with an OTG cable (apk).
Songs: Import song > Songsterr (needs Plus), Guitar Pro file, or "From another device"
(file exported with the arrow button in the library). The first time on the PC, import the old
version's songs\ folder in "From another device".
