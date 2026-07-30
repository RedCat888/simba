# Stops whatever is listening on the gateway port and starts a fresh instance.
param([int]$Port = 8787)

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    $listening | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Write-Host "stopped previous gateway on :$Port"
    Start-Sleep -Seconds 2
}

$root = Split-Path -Parent $PSScriptRoot
$env:SIMBA_GATEWAY_PORT = "$Port"

# Launch through cmd: npx on Windows is a shim script, which Start-Process
# cannot execute directly as a FilePath.
Start-Process -FilePath 'cmd.exe' `
              -ArgumentList '/c', 'npx tsx src/gateway/server.ts' `
              -WorkingDirectory $root -WindowStyle Hidden

foreach ($i in 1..25) {
    try {
        Invoke-RestMethod "http://127.0.0.1:$Port/api/stats" -TimeoutSec 2 | Out-Null
        Write-Host "gateway up on :$Port" -ForegroundColor Green
        exit 0
    } catch { Start-Sleep -Milliseconds 800 }
}
Write-Host "gateway did not come up" -ForegroundColor Red
exit 1
