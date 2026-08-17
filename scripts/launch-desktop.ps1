# Opens Simba as a Windows app window (Edge app mode — no browser chrome,
# no back-button-closes-the-site). The UI is the local control center.
param(
    [string]$Url = 'http://127.0.0.1:8787',
    [int]$Port = 8787,
    [int]$WaitSeconds = 40
)

$ErrorActionPreference = 'Stop'

# Not $profile: that is a PowerShell automatic variable holding the path to the
# user's profile script, and quietly reassigning it is the kind of thing that
# breaks whatever runs next in the same session.
$profileDir = Join-Path $env:LOCALAPPDATA 'Simba\edge-profile'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
    throw 'Microsoft Edge is required for the Simba desktop window.'
}

# The desktop shortcut and the gateway both start at logon, and the shortcut can
# win. Opening the window first shows Edge's connection-error page, which reads
# as "Simba is broken" rather than "Simba is still starting" — and it does not
# reload itself once the gateway comes up. So wait for the port instead.
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

Start-Process -FilePath $edge -ArgumentList @(
    "--app=$Url",
    "--user-data-dir=$profileDir",
    '--new-window'
)
