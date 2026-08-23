# Restarts the keepalive when the keepalive is not there to restart anything.
#
# The SimbaGateway task has stopped twice in one session. Each time it read
# Ready rather than Running, which is Task Scheduler saying the task finished
# rather than failed - and a restart policy only applies to failures, so
# RestartCount 999 sat there and did nothing. Both times the gateway went with
# it and stayed down until a person noticed.
#
# The proper fix is a repeating trigger on that task, and modifying it needs
# elevation the keepalive account does not have. This does not need elevation:
# a user can register their own task, and this one only has to notice that
# nothing is listening and start the supervisor again.
#
# Deliberately checks the port rather than the task state or a process list.
# What matters is whether Simba is answering; a keepalive that is running but
# wedged looks healthy to every other test and is exactly the case that has
# hurt here before.
param([int]$Port = 8787)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $root 'var\log\watchdog.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log([string]$m) {
    Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

# Nothing is serving. Prefer the scheduled task, since that is the supported
# path and keeps one owner for the process; fall back to launching the script
# directly when the task cannot be started from here.
Write-Log "nothing listening on $Port"

$task = Get-ScheduledTask -TaskName 'SimbaGateway' -ErrorAction SilentlyContinue
if ($task -and $task.State -ne 'Running') {
    try {
        Start-ScheduledTask -TaskName 'SimbaGateway' -ErrorAction Stop
        Write-Log 'started the SimbaGateway task'
        exit 0
    } catch {
        Write-Log ("could not start the task ({0}) - launching the keepalive directly" -f $_.Exception.Message.Trim())
    }
}

$keepalive = Join-Path $root 'scripts\keepalive-gateway.ps1'
if (Test-Path $keepalive) {
    Start-Process -FilePath 'powershell.exe' `
                  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $keepalive `
                  -WindowStyle Hidden
    Write-Log 'launched keepalive-gateway.ps1 directly'
} else {
    Write-Log 'keepalive script not found - cannot recover'
}
