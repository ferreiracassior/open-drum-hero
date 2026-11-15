# Builds OpenDrumHero for Windows: release\OpenDrumHero-<version>.exe (a single file, no install needed).
# Uses the same app as the apk: any interface/feature change applies to both.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"
Assert-Node
Build-App

Write-Host "Copying the app into the Windows package..." -ForegroundColor Cyan
$app = Join-Path $DesktopDir "app"
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
Copy-Item (Join-Path $Frontend "dist\frontend\browser") $app -Recurse

Install-NodeDeps $DesktopDir
Push-Location $DesktopDir
try {
    Write-Host "Building the exe (the first time downloads Electron, it takes a while)..." -ForegroundColor Cyan
    npx electron-builder --win portable --x64
    if ($LASTEXITCODE -ne 0) { throw "the exe build failed" }
} finally { Pop-Location }

$exe = Get-ChildItem $Release -Filter "OpenDrumHero-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "Done: $($exe.FullName)" -ForegroundColor Green
Write-Host "Plug the drum kit into the PC USB and open the exe. Library and settings are saved next to it, in config\ and library\."
Start-Process explorer.exe "/select,`"$($exe.FullName)`""
