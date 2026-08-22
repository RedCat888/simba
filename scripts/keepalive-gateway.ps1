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

# Ollama and the voice worker, checked on every pass rather than once at boot.
#
# Both used to be started here exactly once, before the loop, and never looked
# at again. Both were dead on 20 August with the keepalive still running and
# perfectly healthy by its own account, because the only thing it supervised
# was the gateway. That is the same mistake the gateway's own supervision was
# written to fix, left in place one layer down.
#
# The cost of being wrong is asymmetric and quiet. Ollama down means embed()
# throws, recall() catches, and every knowledge search returns "No matches"
# against thirty thousand vectors — an answer indistinguishable from a genuine
# miss. The voice worker down means every spoken sentence silently pays a
# two-second interpreter start instead of 0.16s. Neither announces itself.
$script:lastStart = @{}

# Whisper needs several seconds to load its model and bind 4878, and the first
# pass through the loop happens immediately after the pre-loop call. Without a
# cooldown the port is still unbound on that second look, so a second worker is
# launched into the same port and the same 8GB of VRAM. Seen in the log as two
# identical "starting it" lines in the same second.
function Should-Start([string]$name, [int]$cooldownSeconds = 90) {
    $now = Get-Date
    $prev = $script:lastStart[$name]
    if ($null -ne $prev -and ($now - $prev).TotalSeconds -lt $cooldownSeconds) { return $false }
    $script:lastStart[$name] = $now
    return $true
}

function Ensure-Dependencies {
    $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $ollama) {
        if (-not (Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue) -and (Should-Start 'ollama')) {
            Write-Log 'ollama not running - starting it (embeddings for search)'
            Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
        }
    } elseif (-not $script:warnedOllama) {
        $script:warnedOllama = $true
        Write-Log 'ollama not installed - knowledge search will report unavailable'
    }

    # Borrows ReelAgent's interpreter because faster-whisper and its downloaded
    # model already live there; a second virtualenv would be a second copy of a
    # 2GB dependency to keep in step.
    $voiceWorker = Join-Path $root 'src\voice\worker.py'
    $reelPython  = Join-Path $env:USERPROFILE 'ReelAgent\.venv\Scripts\python.exe'
    if ((Test-Path $voiceWorker) -and (Test-Path $reelPython)) {
        $voiceUp = Get-NetTCPConnection -LocalPort 4878 -State Listen -ErrorAction SilentlyContinue
        if (-not $voiceUp -and (Should-Start 'voice')) {
            Write-Log 'voice worker not listening on 4878 - starting it (whisper, held warm)'
            Start-Process -FilePath $reelPython -ArgumentList $voiceWorker -WindowStyle Hidden
        }
    } elseif (-not $script:warnedVoice) {
        $script:warnedVoice = $true
        Write-Log 'voice worker not startable - speech falls back to the slow per-request path'
    }
}

Ensure-Dependencies

$backoff = 2
while ($true) {
    Ensure-Dependencies

    # Something else already holding the port means a manual run is in progress.
    # Restarting over the top of it would be the more destructive choice.
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($held) {
        Start-Sleep -Seconds 15
        continue
    }

    Write-Log "starting gateway"
    $started = Get-Date

    # Capture the gateway's own output, because until now there was none.
    #
    # On 17 August the log recorded "gateway exited after 5s with 0x1" and that
    # was the entire record of the failure. Started hidden through cmd, stdout
    # and stderr went to a console nobody would ever see, so the one thing that
    # would have named the cause — a stack trace, or EADDRINUSE — was discarded
    # at the moment it was produced. An exit code alone cannot distinguish a
    # port collision from a bad migration from a syntax error.
    #
    # The previous run is rolled to .1 rather than appended to: Start-Process
    # truncates its redirect targets, and the interesting output is almost
    # always from the run that just died, not the one about to start.
    $outLog = Join-Path $LogDir 'gateway-out.log'
    $errLog = Join-Path $LogDir 'gateway-err.log'
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) { Move-Item -Path $f -Destination "$f.1" -Force -ErrorAction SilentlyContinue }
    }

    # npx on Windows is a shim script, so it goes through cmd rather than being
    # executed directly.
    $p = Start-Process -FilePath 'cmd.exe' `
                       -ArgumentList '/c', "npx tsx src/gateway/server.ts" `
                       -WorkingDirectory $root -WindowStyle Hidden -PassThru `
                       -RedirectStandardOutput $outLog -RedirectStandardError $errLog

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

    # The last few lines of stderr, inline. Whoever reads this log is asking
    # "why did it stop", and making them open a second file to find out is the
    # difference between a diagnosis and a shrug. Only on a non-zero exit, so a
    # clean shutdown does not drag noise in behind it.
    if ($exit -ne 0 -and (Test-Path $errLog)) {
        $tail = Get-Content $errLog -Tail 12 -ErrorAction SilentlyContinue |
                Where-Object { $_.Trim() }
        foreach ($line in $tail) { Write-Log "  | $line" }
    }

    # A process that survived a while was working; restart it promptly. One that
    # dies immediately is failing for a reason restarting will not fix, so back
    # off rather than spinning — but keep trying, because the reason is often
    # something that clears on its own.
    if ($ran -ge 60) { $backoff = 2 } else { $backoff = [Math]::Min($backoff * 2, 300) }
    Write-Log "restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
}
