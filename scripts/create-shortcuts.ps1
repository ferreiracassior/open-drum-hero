# Creates Windows shortcuts (.lnk) for the OpenDrumHero scripts in the shortcuts\ folder
# (and, if you want, also on the Desktop).
param([switch]$Desktop)
. "$PSScriptRoot\_common.ps1"
$out = Join-Path $Root "shortcuts"
$icon = Join-Path $Root "desktop\icon.ico"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$shell = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath("Desktop")

# Shortcuts from older versions (Portuguese names, Python server), removed here and on the Desktop
$obsolete = @("Drum Hero - Iniciar", "Drum Hero - Compilar app", "Drum Hero - Instalar ou atualizar",
              "Drum Hero - Login Songsterr", "Drum Hero - Checar Songsterr", "Drum Hero - Reconectar celular USB",
              "Drum Hero - Diagnostico MIDI", "Drum Hero - Monitor MIDI", "Drum Hero - Pasta das musicas",
              "Drum Hero - Gerar exe (Windows)", "Drum Hero - Gerar apk (Android)",
              "Drum Hero - Gerar apk (Android) e instalar no celular conectado",
              "Drum Hero - Instalar dependencias", "Drum Hero - Testar no navegador", "Drum Hero - Pasta dos instaladores",
              "Drum Hero - Build exe (Windows)", "Drum Hero - Build apk (Android) and install on connected phone",
              "Drum Hero - Install dependencies", "Drum Hero - Test in browser", "Drum Hero - Installers folder")
foreach ($dir in @($out, $desk)) {
    foreach ($o in $obsolete) { Remove-Item (Join-Path $dir ($o + ".lnk")) -ErrorAction SilentlyContinue }
}

# Shortcut name, script, description
$items = @(
    @("OpenDrumHero - Build exe (Windows)", "build-exe.ps1", "Builds release\OpenDrumHero-x.exe with the current app"),
    @("OpenDrumHero - Build apk (Android) and install on connected phone", "build-apk.ps1",
      "Builds release\OpenDrumHero-x.apk (Android 13+). If the phone is on the USB cable with USB debugging on, it also installs it"),
    @("OpenDrumHero - Install dependencies", "setup.ps1", "Installs/updates the dependencies and runs the tests"),
    @("OpenDrumHero - Test in browser", "dev.ps1", "Opens the app in the browser for development")
)

$made = @()
foreach ($it in $items) {
    $lnk = Join-Path $out ($it[0] + ".lnk")
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = $ps
    $script = Join-Path $Root ("scripts\" + $it[1])
    $s.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$script`""
    $s.WorkingDirectory = $Root
    if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
    $s.Description = $it[2]
    $s.Save()
    $made += $lnk
}

# Shortcut to the folder with the built exe and apk
New-Item -ItemType Directory -Force $Release | Out-Null
$lnk = Join-Path $out "OpenDrumHero - Installers folder.lnk"
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $Release
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()
$made += $lnk

Write-Host "Shortcuts created in $out" -ForegroundColor Green
$made | ForEach-Object { Write-Host "  - $(Split-Path $_ -Leaf)" }

if (-not $Desktop) {
    $ans = Read-Host "Also copy them to the Desktop? (y/N)"
    $Desktop = $ans -match '^[yYsS]'
}
if ($Desktop) {
    $made | ForEach-Object { Copy-Item $_ $desk -Force }
    Write-Host "Copied to $desk" -ForegroundColor Green
}
