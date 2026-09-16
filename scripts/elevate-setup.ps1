# One-time elevated setup. Run once; accept the UAC prompt.
#
# Everything here needs administrator rights and nothing else in Simba does.
# Deliberately narrow: it registers the database as a service and stops the
# machine sleeping. It does not touch security settings, firewall rules, or
# anything outside this project's needs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\elevate-setup.ps1
#
# Re-running is safe: every step checks its current state first.

$ErrorActionPreference = 'Continue'

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Not elevated - relaunching with a UAC prompt...' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $PSCommandPath
    )
    exit 0
}

Write-Host '=== Simba elevated setup ===' -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. PostgreSQL as a Windows service.
#
# Currently Postgres only runs because it was started by hand, so a reboot
# takes the whole system down until someone notices. A service starts it before
# anyone logs in, which also means Simba survives an unattended restart.
# ---------------------------------------------------------------------------
$pgBin  = 'C:\example-workspace\scoop\apps\postgresql\current\bin'
$pgData = 'C:\example-workspace\scoop\persist\postgresql\data'

$existing = Get-Service -Name 'PostgreSQL' -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  PostgreSQL service already registered (status: $($existing.Status))"
} else {
    Write-Host '  Registering PostgreSQL service...'
    & "$pgBin\pg_ctl.exe" register -N 'PostgreSQL' -D $pgData -S auto
    if ($LASTEXITCODE -eq 0) {
        & sc.exe description PostgreSQL 'PostgreSQL 18 - Simba database' | Out-Null
        Write-Host '  Registered.' -ForegroundColor Green
    } else {
        Write-Host '  Registration failed.' -ForegroundColor Red
    }
}

# A hand-started postgres holds the data directory and will block the service.
$manual = Get-Process -Name 'postgres' -ErrorAction SilentlyContinue
if ($manual) {
    Write-Host '  Stopping the manually started server so the service can take over...'
    & "$pgBin\pg_ctl.exe" -D $pgData -m fast stop | Out-Null
    Start-Sleep -Seconds 3
}

try {
    Start-Service -Name 'PostgreSQL' -ErrorAction Stop
    Write-Host '  Service started.' -ForegroundColor Green
} catch {
    Write-Host "  Could not start service: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Falling back to a manual start so the database stays up.' -ForegroundColor Yellow
    & "$pgBin\pg_ctl.exe" -D $pgData -l 'C:\example-workspace\simba\var\logs\pg.log' start | Out-Null
}

# ---------------------------------------------------------------------------
# 2. Stop the machine sleeping.
#
# Sleep kills every running agent session mid-task. Checkpointing means work is
# recoverable, but a machine that is meant to be reachable from a phone should
# not be going to sleep in the first place. Display timeout is left alone - the
# monitor turning off is harmless.
# ---------------------------------------------------------------------------
Write-Host '  Disabling sleep and hibernate on AC power...'
& powercfg /change standby-timeout-ac 0
& powercfg /change hibernate-timeout-ac 0
& powercfg /change disk-timeout-ac 0
Write-Host '  Done.' -ForegroundColor Green

# ---------------------------------------------------------------------------
# 3. Report. Nothing below changes anything.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '=== Result ===' -ForegroundColor Cyan
Get-Service -Name 'PostgreSQL' -ErrorAction SilentlyContinue |
    Select-Object Name, Status, StartType | Format-Table -AutoSize

Write-Host 'Sleep settings (AC):'
& powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE |
    Select-String -Pattern 'Current AC Power Setting' | Select-Object -First 1

Write-Host ''
Write-Host 'Elevated setup complete. This does not need to run again.' -ForegroundColor Green
Read-Host 'Press Enter to close'
