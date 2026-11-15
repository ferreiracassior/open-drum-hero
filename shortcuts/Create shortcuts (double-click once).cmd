@echo off
rem Double-click: creates the OpenDrumHero shortcuts in this folder (and optionally on the Desktop).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\create-shortcuts.ps1"
pause
