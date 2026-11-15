# Builds OpenDrumHero for Android 13+: release\OpenDrumHero.apk. If the phone is on the cable with
# USB debugging on, it also installs it there.
# Uses the same app as the exe: any interface/feature change applies to both.
# Needs Android Studio installed (it brings Java and the Android SDK).
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"
Assert-Node

$java = Find-Java
if (-not $java) { throw "Java 21 not found. Install Android Studio (it brings Java) and run again." }
$sdk = Find-AndroidSdk
if (-not $sdk) { throw "Android SDK not found. Open Android Studio once (it installs the SDK) and run again." }
$env:JAVA_HOME = $java
$env:ANDROID_HOME = $sdk
Write-Host "Java: $java"
Write-Host "SDK:  $sdk"

Build-App
Push-Location $Frontend
try {
    Write-Host "Copying the app into the Android project..." -ForegroundColor Cyan
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }
} finally { Pop-Location }

# accepts the SDK licenses (Gradle downloads whatever is missing)
$sdkmanager = Get-ChildItem (Join-Path $sdk "cmdline-tools") -Recurse -Filter "sdkmanager.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($sdkmanager) { "y`ny`ny`ny`ny`ny`ny`ny`n" | & $sdkmanager.FullName --licenses | Out-Null }

$android = Join-Path $Frontend "android"
Set-Content (Join-Path $android "local.properties") ("sdk.dir=" + ($sdk -replace '\\', '\\'))
Push-Location $android
try {
    Write-Host "Building the apk (the first time downloads Gradle, it takes a few minutes)..." -ForegroundColor Cyan
    .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "the apk build failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $Release | Out-Null
$apk = Join-Path $Release "OpenDrumHero.apk"
Copy-Item (Join-Path $android "app\build\outputs\apk\debug\app-debug.apk") $apk -Force
Write-Host ""
Write-Host "Done: $apk" -ForegroundColor Green

$adb = Get-Adb
if ($adb) {
    $devices = & $adb devices | Select-String "`tdevice$"
    if ($devices) {
        Write-Host "Installing on the connected phone..." -ForegroundColor Cyan
        & $adb install -r $apk
    } else {
        Write-Host "To install: plug the phone into the cable (USB debugging) and run again, or copy the apk to the phone."
    }
}
Start-Process explorer.exe "/select,`"$apk`""
