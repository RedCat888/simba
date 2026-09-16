# Gives the keepalive task a heartbeat, so nothing has to have died "correctly".
#
# The task already carries RestartCount 999 and a one-minute interval, and that
# is not what it looks like. Task Scheduler only applies a restart policy when a
# task *fails*; a task that ends any other way is simply Ready, and Ready never
# restarts. That is the exact trap the 0xC000013A outage taught in August, and
# it happened again today: the keepalive stopped, the task read Ready, the
# gateway went with it, and nothing tried again because from the scheduler's
# point of view nothing had gone wrong.
#
# A repetition does not care how it ended. Every five minutes the trigger fires;
# MultipleInstances is already IgnoreNew, so a launch while the keepalive is
# healthy is discarded, and a launch after it died brings it back. The script
# itself is idempotent by design - it sees the port held and idles - so a
# duplicate is harmless even in the window before IgnoreNew applies.
$ErrorActionPreference = 'Stop'

# Modifying a task registered with elevation needs elevation itself, and
# Set-ScheduledTask reports that as a bare CIM 0x80070005 that says nothing
# about what to do next.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'This needs an elevated PowerShell - the SimbaGateway task was registered with elevation.' -ForegroundColor Yellow
    Write-Host 'Run PowerShell as administrator, then:' -ForegroundColor Yellow
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File C:\example-workspace\simba\scripts\install-keepalive-heartbeat.ps1'
    exit 1
}

$task = Get-ScheduledTask -TaskName 'SimbaGateway'
# Duration is left unset rather than given a maximum. [TimeSpan]::MaxValue
# renders as P99999999DT23H59M59S, which Task Scheduler rejects outright with
# 0x80041318; an absent duration is how the API spells "indefinitely".
$trigger = New-ScheduledTaskTrigger -AtLogOn
$repeat = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$repeat.Duration = $null
$trigger.Repetition = $repeat

Set-ScheduledTask -TaskName 'SimbaGateway' -Trigger $trigger | Out-Null

$after = Get-ScheduledTask -TaskName 'SimbaGateway'
foreach ($t in $after.Triggers) {
    Write-Output ("  trigger    : {0}" -f $t.CimClass.CimClassName)
    Write-Output ("  repetition : every {0}, for {1}" -f $t.Repetition.Interval, $t.Repetition.Duration)
}
Write-Output ("  instances  : {0}" -f $after.Settings.MultipleInstances)
Write-Output ("  state      : {0}" -f $after.State)
