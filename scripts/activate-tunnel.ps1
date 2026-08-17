# Final activation for remote phone access.
#
# Everything up to this point is inert: the ingress rule exists but no DNS
# record points at it, cloudflared is not running, and the gateway's tunnel
# listener does not start unless Access is configured. Nothing is publicly
# reachable until this script runs.
#
# Run it only AFTER creating the Access application, because the values it needs
# come from there.
#
#   powershell -File scripts\activate-tunnel.ps1 `
#       -Aud <application-audience-tag> `
#       -Team <your-team-name> `
#       -Email you@gmail.com `
#       -ServiceTokenClientId <uuid>.access
#
# The client SECRET is never passed here — it belongs only on the phone.

param(
    [Parameter(Mandatory = $true)][string]$Aud,
    [Parameter(Mandatory = $true)][string]$Team,
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$ServiceTokenClientId,
    [string]$Hostname = 'simba.plaximus.com',
    [string]$Tunnel   = 'plaximus-local'
)

$ErrorActionPreference = 'Stop'
$cf = 'C:\ProgramData\chocolatey\bin\cloudflared.exe'

Write-Host '=== 1. Sanity: the tunnel must not point at the trusted local port ===' -ForegroundColor Cyan
$cfg = Get-Content 'C:\Users\operator\.cloudflared\config.yml' -Raw
if ($cfg -match '127\.0\.0\.1:8787' -or $cfg -match 'localhost:8787') {
    throw "config.yml routes traffic to 8787, the trusted local channel. Refusing to activate."
}
Write-Host '  ok - tunnel targets 8788 only' -ForegroundColor Green

Write-Host '=== 2. Persist Access settings for the gateway ===' -ForegroundColor Cyan
# Machine scope so the scheduled task that starts the gateway at logon sees them.
[Environment]::SetEnvironmentVariable('SIMBA_TUNNEL_ENABLED', '1', 'User')
[Environment]::SetEnvironmentVariable('SIMBA_ACCESS_TEAM', $Team, 'User')
[Environment]::SetEnvironmentVariable('SIMBA_ACCESS_AUD', $Aud, 'User')
[Environment]::SetEnvironmentVariable('SIMBA_ACCESS_EMAILS', $Email, 'User')
[Environment]::SetEnvironmentVariable('SIMBA_ACCESS_SERVICE_TOKENS', "$ServiceTokenClientId=phone", 'User')
Write-Host '  ok - the gateway now refuses to start if any of these go missing' -ForegroundColor Green

Write-Host '=== 3. Create the DNS route ===' -ForegroundColor Cyan
# cloudflared writes its INF logs to stderr, which PowerShell turns into error
# records that trip ErrorActionPreference='Stop'. Redirect and judge by content,
# not by the presence of stderr output.
$dnsOut = (& $cf tunnel route dns $Tunnel $Hostname 2>&1 | Out-String)
if ($dnsOut -notmatch 'Added CNAME|already (exists|configured)') {
    throw "DNS route failed: $dnsOut"
}
Write-Host "  ok - $Hostname" -ForegroundColor Green

Write-Host '=== 4. Restart the gateway with the tunnel listener enabled ===' -ForegroundColor Cyan
$env:SIMBA_TUNNEL_ENABLED = '1'
$env:SIMBA_ACCESS_TEAM = $Team
$env:SIMBA_ACCESS_AUD = $Aud
$env:SIMBA_ACCESS_EMAILS = $Email
$env:SIMBA_ACCESS_SERVICE_TOKENS = "$ServiceTokenClientId=phone"
& "$PSScriptRoot\restart-gateway.ps1"

Start-Sleep -Seconds 3
try {
    Invoke-RestMethod 'http://127.0.0.1:8788/api/stats' -TimeoutSec 5 | Out-Null
    Write-Host '  WARNING: tunnel listener answered WITHOUT an Access assertion.' -ForegroundColor Red
    Write-Host '  This should have been 401. Do not start cloudflared.' -ForegroundColor Red
    exit 1
} catch {
    Write-Host '  ok - tunnel listener rejects unauthenticated requests' -ForegroundColor Green
}

Write-Host '=== 5. Start cloudflared ===' -ForegroundColor Cyan
Start-Process -FilePath $cf -ArgumentList 'tunnel', 'run', $Tunnel -WindowStyle Hidden
Start-Sleep -Seconds 6

Write-Host ''
Write-Host "Activated. Verify from a browser: https://$Hostname/api/stats" -ForegroundColor Green
Write-Host 'Expect a Google sign-in, then JSON. The web UI is deliberately NOT'
Write-Host 'served over the tunnel - the phone uses the native app.'
Write-Host ''
Write-Host 'To install cloudflared as a service so it survives reboot, run elevated:'
Write-Host "  $cf service install"
