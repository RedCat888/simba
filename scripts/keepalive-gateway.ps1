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

# Ollama, because search silently depends on it.
#
# Every knowledge search answered "No matches" for an unknown stretch because
# Ollama was not running: embed() throws, recall() catches and returns nothing,
# and an empty result is indistinguishable from a genuine miss. There are thirty
# thousand vectors in the database, so "no matches" was never true. Starting it
# here rather than in its own task keeps the dependency visible — the thing that
# needs it is the thing that starts it.
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (Test-Path $ollama) {
    $running = Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue
    if (-not $running) {
        Write-Log 'starting ollama (embeddings for search)'
        Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
    }
} else {
    Write-Log 'ollama not installed — knowledge search will report unavailable'
}

# The voice worker: Whisper held warm on the 3070.
#
# Without it every spoken sentence pays an interpreter start and a full model
# load — measured at two seconds for four words, of which the transcription
# itself is a small fraction. With it, 0.16s. That gap is the difference between
# talking to Simba and submitting requests to it.
#
# It borrows ReelAgent's interpreter because that is where faster-whisper and
# its downloaded model already live; a second virtualenv would be a second copy
# of a 2GB dependency to keep in step.
$voiceWorker = Join-Path $root 'src\voice\worker.py'
$reelPython  = Join-Path $env:USERPROFILE 'ReelAgent\.venv\Scripts\python.exe'
if ((Test-Path $voiceWorker) -and (Test-Path $reelPython)) {
    $voiceUp = Get-NetTCPConnection -LocalPort 4878 -State Listen -ErrorAction SilentlyContinue
    if (-not $voiceUp) {
        Write-Log 'starting the voice worker (whisper, held warm)'
        Start-Process -FilePath $reelPython -ArgumentList $voiceWorker -WindowStyle Hidden
    }
} else {
    Write-Log 'voice worker not startable — speech falls back to the slow per-request path'
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
