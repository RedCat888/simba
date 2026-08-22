# Opens the Simba desktop app (Electron) — its own windows, tray, and overlay.
# Not a browser pointed at localhost.
param(
    [int]$Port = 8787,
    [int]$WaitSeconds = 40
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'desktop'
$electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    $electron = Join-Path $desktop 'node_modules\.bin\electron.cmd'
}
if (-not (Test-Path $electron)) {
    throw 'Desktop app is not installed. From the repo root run: npm install --prefix desktop'
}

$dist = Join-Path $desktop 'dist\index.html'
Push-Location $desktop
npm run build
Pop-Location
if (-not (Test-Path $dist)) {
    throw 'Desktop UI failed to build (desktop/dist/index.html missing).'
}

$ready = $false
foreach ($i in 1..$WaitSeconds) {
    if (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port `
                           -InformationLevel Quiet -WarningAction SilentlyContinue) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Warning "Gateway not listening on $Port after ${WaitSeconds}s — opening anyway."
}

Start-Process -FilePath $electron -ArgumentList @('.') -WorkingDirectory $desktop
