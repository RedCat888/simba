# Brings Simba back after simba-stop.ps1.
#
# Starts the keepalive, which is the thing that owns everything else: it waits
# for Postgres, starts ollama and the voice worker if they are down, and runs
# the gateway as a child it restarts on any exit. So this script mostly just
# needs to start one task and then confirm the rest followed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\simba-start.ps1

param([int]$Port = 8787, [int]$WaitSeconds = 90)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

Write-Host 'Starting Simba...' -ForegroundColor Cyan

# Postgres first, because nothing is worth starting without it. The service is
# preferred; if this shell cannot control it, pg_ctl still can.
$pgUp = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($pgUp) {
    Write-Host '  postgres               already listening'
} else {
    $svc = Get-Service -Name 'PostgreSQL' -ErrorAction SilentlyContinue
    $started = $false
    if ($svc) {
        try { Start-Service -Name 'PostgreSQL' -ErrorAction Stop; $started = $true; Write-Host '  postgres               service started' -ForegroundColor Green }
        catch { Write-Host '  postgres               service start denied, falling back to pg_ctl' -ForegroundColor Yellow }
    }
    if (-not $started) {
        $pgCtl  = 'C:\Users\operator\scoop\apps\postgresql\current\bin\pg_ctl.exe'
        $pgData = 'C:\Users\operator\scoop\persist\postgresql\data'
        if (Test-Path $pgCtl) {
            $pgLog = Join-Path $root 'var\logs\pg.log'
            New-Item -ItemType Directory -Force -Path (Split-Path $pgLog) | Out-Null
            Start-Process -FilePath $pgCtl -ArgumentList '-D', $pgData, '-l', $pgLog, '-w', 'start' -WindowStyle Hidden
            Write-Host '  postgres               started with pg_ctl' -ForegroundColor Green
        } else {
            Write-Host '  postgres               pg_ctl not found - cannot start' -ForegroundColor Red
        }
    }
}

# The keepalive owns the gateway, ollama and the voice worker.
$task = Get-ScheduledTask -TaskName 'SimbaGateway' -ErrorAction SilentlyContinue
if ($task) {
    Start-ScheduledTask -TaskName 'SimbaGateway'
    Write-Host '  keepalive              started' -ForegroundColor Green
} else {
    Write-Host '  keepalive              no SimbaGateway task; starting it directly' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' `
                  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\keepalive-gateway.ps1') `
                  -WindowStyle Hidden
}

Write-Host '  waiting for the gateway...'
$up = $false
foreach ($i in 1..$WaitSeconds) {
    Start-Sleep -Seconds 1
    try {
        Invoke-RestMethod "http://127.0.0.1:$Port/api/stats" -TimeoutSec 2 | Out-Null
        $up = $true
        Write-Host ("  gateway                up after {0}s" -f $i) -ForegroundColor Green
        break
    } catch { }
}
if (-not $up) { Write-Host '  gateway                did not come up - check var\log\gateway-keepalive.log' -ForegroundColor Red }

if ($up) {
    # Give the slow dependency a moment before reporting.
    #
    # The gateway answers within seconds, but the voice worker has to load a
    # Whisper model onto the GPU first, so an immediate health check reports it
    # degraded every single time - which trains you to ignore the line that
    # would matter if it were still degraded a minute later.
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 2
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 10
            if (-not ($h.dependencies | Where-Object { $_.state -ne 'up' })) { break }
        } catch { }
    }
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 10
        foreach ($d in $h.dependencies) {
            $colour = if ($d.state -eq 'up') { 'Green' } else { 'Yellow' }
            Write-Host ("  {0,-22} {1}" -f $d.name, $d.state) -ForegroundColor $colour
        }
    } catch { Write-Host '  health check failed' -ForegroundColor Yellow }
}
