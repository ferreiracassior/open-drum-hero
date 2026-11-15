# Functions shared by the scripts (ASCII only, for PowerShell 5.1).
$Root = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path $Root "frontend"
$DesktopDir = Join-Path $Root "desktop"   # (do not use $Desktop: it is the create-shortcuts parameter)
$Release = Join-Path $Root "release"

function Assert-Node {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "Node.js not found. Install Node LTS (winget install OpenJS.NodeJS.LTS) and open the shortcut again."
    }
}

# npm install only when needed: first time or when package.json changed
function Install-NodeDeps([string]$Dir) {
    Push-Location $Dir
    try {
        $lock = "node_modules\.package-lock.json"
        if (-not (Test-Path $lock) -or (Get-Item "package.json").LastWriteTime -gt (Get-Item $lock).LastWriteTime) {
            Write-Host "Installing dependencies in $Dir ..." -ForegroundColor Cyan
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install failed in $Dir" }
        }
    } finally { Pop-Location }
}

# Version of the exe and the apk: version.json at the root is the only place to change it.
#   "version"  : x.y.z shown by the exe/apk (Windows file name, Android "versionName")
#   "build"    : integer that always goes up (Android "versionCode": a phone only updates to a higher one)
#   "autoBump" : true = every build adds 1 to the last number of "version" and to "build" (off until the
#                first public release; turn it on by editing version.json)
# The version is then written to desktop/package.json, frontend/package.json and frontend/android/app/build.gradle.
function Update-Version {
    $file = Join-Path $Root "version.json"
    $v = Get-Content $file -Raw | ConvertFrom-Json
    if ($v.autoBump) {
        $parts = $v.version.Split(".")
        $parts[2] = [string]([int]$parts[2] + 1)
        $v.version = $parts -join "."
        $v.build = [int]$v.build + 1
        $json = "{`n  `"version`": `"$($v.version)`",`n  `"build`": $($v.build),`n  `"autoBump`": true`n}`n"
        [IO.File]::WriteAllText($file, $json)
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($pkg in @((Join-Path $DesktopDir "package.json"), (Join-Path $Frontend "package.json"))) {
        $text = [IO.File]::ReadAllText($pkg)
        $text = [regex]::new('"version":\s*"[^"]*"').Replace($text, "`"version`": `"$($v.version)`"", 1)
        [IO.File]::WriteAllText($pkg, $text, $utf8)
    }
    $gradle = Join-Path $Frontend "android\app\build.gradle"
    $text = [IO.File]::ReadAllText($gradle)
    $text = [regex]::Replace($text, 'versionCode\s+\d+', "versionCode $($v.build)")
    $text = [regex]::Replace($text, 'versionName\s+"[^"]*"', "versionName `"$($v.version)`"")
    [IO.File]::WriteAllText($gradle, $text, $utf8)
    Write-Host "Version $($v.version) (build $($v.build))" -ForegroundColor Cyan
}

# Builds the app (the SAME one for the exe and the apk)
function Build-App {
    Update-Version
    Install-NodeDeps $Frontend
    Push-Location $Frontend
    try {
        Write-Host "Building the app..." -ForegroundColor Cyan
        npx ng build
        if ($LASTEXITCODE -ne 0) { throw "the app build failed" }
        # the license and the third-party notices go inside the exe and the apk too
        $out = Join-Path $Frontend "dist\frontend\browser"
        Copy-Item (Join-Path $Root "LICENSE") (Join-Path $out "LICENSE.txt") -Force
        Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") (Join-Path $out "third-party-notices.txt") -Force
    } finally { Pop-Location }
}

function Get-Adb {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdk) { return $sdk }
    return $null
}

# Java 21 for Gradle: the one that comes with Android Studio (jbr) works
function Find-Java {
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) { return $env:JAVA_HOME }
    $candidates = @(
        "$env:ProgramFiles\Android\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "${env:ProgramFiles(x86)}\Android\Android Studio\jbr"
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path (Join-Path $c "bin\java.exe"))) { return $c } }
    $jdk = Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium", "$env:ProgramFiles\Java", "$env:ProgramFiles\Microsoft" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "jdk-?2[1-9]" } | Select-Object -First 1
    if ($jdk) { return $jdk.FullName }
    return $null
}

function Find-AndroidSdk {
    foreach ($c in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk"))) {
        if ($c -and (Test-Path (Join-Path $c "platform-tools"))) { return $c }
    }
    return $null
}
