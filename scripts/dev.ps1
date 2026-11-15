# Development: opens the app in the browser with auto reload (http://localhost:4200).
# The drum kit works through Chrome/Edge Web MIDI; Songsterr only inside the exe/apk.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"
Assert-Node
Install-NodeDeps $Frontend
Set-Location $Frontend
npx ng serve --open
