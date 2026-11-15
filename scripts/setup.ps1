# Installs the (Node) dependencies of the app and the Windows package, and checks what the apk needs.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"
Assert-Node
Install-NodeDeps $Frontend
Install-NodeDeps $DesktopDir
Push-Location $Frontend
try { npx ng test --watch=false } finally { Pop-Location }
if (-not (Find-Java) -or -not (Find-AndroidSdk)) {
    Write-Warning "To build the apk, install Android Studio (it brings Java and the Android SDK) and open it once."
}
Write-Host "`nDone. Use the 'Build exe' and 'Build apk' shortcuts." -ForegroundColor Green
