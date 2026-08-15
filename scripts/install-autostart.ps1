# Registers the Simba gateway to start at logon and restart if it dies.
#
# Postgres is a service and starts before login; the gateway runs as you,
# because it spawns agent CLIs that need your credentials and config
# directories. A logon-triggered scheduled task is the right shape for that and
# needs no elevation.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'SimbaGateway'
$root = Split-Path -Parent $PSScriptRoot

# Runs the keepalive loop, not the gateway directly.
#
# Pointing the task straight at the server looked simpler and quietly did not
# work: on 13 August it exited with 0xC000013A (STATUS_CONTROL_C_EXIT) twenty
# seconds after logon and stayed dead for two days, because Task Scheduler reads
# that code as a user-initiated stop rather than a failure and so never applied
# the restart policy below. The keepalive never exits, which makes the question
# of how Task Scheduler classifies an exit irrelevant.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\keepalive-gateway.ps1' `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# The restart policy is kept as a second line of defence, for the case where the
# keepalive itself is killed. It is no longer the only thing standing between a
# crash and an outage. StartWhenAvailable covers the machine having been off at
# the scheduled moment; ExecutionTimeLimit 0 means never kill it for running
# too long, which for a daemon is the point.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch {}

Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Simba gateway - agent orchestration, HTTP + websockets on :8787' | Out-Null

Write-Host "Registered scheduled task '$taskName' (starts at logon)." -ForegroundColor Green
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
