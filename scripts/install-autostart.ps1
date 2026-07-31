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

$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument '/c npx tsx src/gateway/server.ts' `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartCount/RestartInterval cover a crash; StartWhenAvailable covers the
# machine having been off at the scheduled moment. ExecutionTimeLimit 0 means
# never kill it for running too long, which for a daemon is the point.
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
