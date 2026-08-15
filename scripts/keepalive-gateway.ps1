# Keeps the gateway alive, without depending on Task Scheduler to notice it died.
#
# The task was registered with RestartCount 999 and a one-minute interval, and
# the comment beside it said that covered a crash. It did not. On 13 August the
# gateway started at logon, exited twenty seconds later with 0xC000013A —
# STATUS_CONTROL_C_EXIT — and never came back. Task Scheduler reads that code as
# "the user stopped this", not as a failure, so the restart policy structurally
# could not fire. The phone had nothing to talk to for two days and every
# request from it failed.
#
# So the supervision moves in here. This script is what the task runs, it never
# exits on its own, and the gateway is a child it restarts on any exit for any
# reason. Task Scheduler's only remaining job is to start this once at logon,
# which is the part it does reliably.
#
#   powershell -ExecutionPolicy Bypass -File scripts\keepalive-gateway.ps1

param(
    [int]$Port = 8787,
    [string]$LogDir = "$PSScriptRoot\..\var\log"
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir 'gateway-keepalive.log'

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

# A scheduled task can start without the interactive user's environment block,
# and the Access settings live there. Without them the gateway comes up but the
# authenticated tunnel listener never opens — running, and useless to the phone.
$persisted = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
foreach ($name in @(
    'SIMBA_TUNNEL_ENABLED', 'SIMBA_ACCESS_TEAM', 'SIMBA_ACCESS_AUD',
    'SIMBA_ACCESS_EMAILS', 'SIMBA_ACCESS_SERVICE_TOKENS', 'SIMBA_TUNNEL_PORT',
    'SIMBA_REEL_URL', 'SIMBA_REEL_TOKEN'
)) {
    $value = $persisted.$name
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
$env:SIMBA_GATEWAY_PORT = "$Port"

Write-Log "keepalive starting (port $Port, pid $PID)"

# Postgres is a service and usually wins the race at boot, but "usually" is what
# produced a two-day outage. Nothing here is worth starting without a database.
foreach ($i in 1..60) {
    $ok = Test-NetConnection -ComputerName '127.0.0.1' -Port 5432 -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($ok) { break }
    if ($i -eq 1) { Write-Log 'waiting for postgres on 5432' }
    Start-Sleep -Seconds 2
}

$backoff = 2
while ($true) {
    # Something else already holding the port means a manual run is in progress.
    # Restarting over the top of it would be the more destructive choice.
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($held) {
        Start-Sleep -Seconds 15
        continue
    }

    Write-Log "starting gateway"
    $started = Get-Date
    # npx on Windows is a shim script, so it goes through cmd rather than being
    # executed directly.
    $p = Start-Process -FilePath 'cmd.exe' `
                       -ArgumentList '/c', "npx tsx src/gateway/server.ts" `
                       -WorkingDirectory $root -WindowStyle Hidden -PassThru

    # Polled rather than -Wait, and this is not a style choice.
    #
    # With -Wait this script died alongside the gateway it was supervising:
    # force-killing the child took the supervisor with it and the task ended
    # 0xC000013A, which is the exact failure mode the keepalive exists to
    # prevent, reproduced one level up. A supervisor that only survives its
    # child's *graceful* exits is no supervisor at all, because graceful exits
    # were never the problem.
    while ($true) {
        Start-Sleep -Seconds 5
        $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if (-not $alive) { break }
    }
    $exit = try { $p.ExitCode } catch { $null }
    $ran = [int]((Get-Date) - $started).TotalSeconds
    Write-Log ("gateway exited after {0}s with {1}" -f $ran,
               $(if ($null -ne $exit) { "0x$('{0:X}' -f $exit)" } else { 'unknown' }))

    # A process that survived a while was working; restart it promptly. One that
    # dies immediately is failing for a reason restarting will not fix, so back
    # off rather than spinning — but keep trying, because the reason is often
    # something that clears on its own.
    if ($ran -ge 60) { $backoff = 2 } else { $backoff = [Math]::Min($backoff * 2, 300) }
    Write-Log "restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
}
