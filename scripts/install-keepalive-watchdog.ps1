# Registers the watchdog as a task this account owns.
#
# No elevation: a user may register a task that runs as themselves. That is the
# whole reason this exists rather than adding a repeating trigger to
# SimbaGateway, which was registered with elevation and cannot be modified from
# here.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'scripts\keepalive-watchdog.ps1'
if (-not (Test-Path $script)) { throw "watchdog script not found at $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script) `
    -WorkingDirectory $root

# A time trigger repeating every five minutes, indefinitely.
#
# Not -AtLogOn: a logon trigger can be written to fire for any user, so
# registering one needs elevation, and this exists precisely because elevation
# is not available. A once-trigger dated in the past with a repetition covers
# the same ground - it is already due, so it starts immediately and keeps
# firing. Duration is left unset because a maximum TimeSpan renders as
# P99999999DT23H59M59S, which Task Scheduler rejects outright.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger.Repetition.Duration = $null

# IgnoreNew so a slow run is never overlapped, and no execution limit because
# the default of three days would eventually stop it.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

Register-ScheduledTask -TaskName 'SimbaWatchdog' -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Restarts the Simba keepalive when nothing is serving on 8787' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'SimbaWatchdog'
Write-Output ("  registered : {0}  ({1})" -f $t.TaskName, $t.State)
foreach ($tr in $t.Triggers) {
    Write-Output ("  repetition : every {0}" -f $tr.Repetition.Interval)
}
Write-Output ("  instances  : {0}" -f $t.Settings.MultipleInstances)
