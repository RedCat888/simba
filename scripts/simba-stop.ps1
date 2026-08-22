# Stops Simba and hands its memory back.
#
# For when the machine is needed for something heavy - a Gradle build, a model
# load, anything that has previously died on this box with a commit-charge
# error rather than a real fault.
#
# Deliberately surgical. It matches Simba's own processes by command line and
# never touches node.exe, python.exe or java.exe generally: Cursor, Claude Code
# and their MCP servers are all node, and killing those mid-edit is a far worse
# outcome than a slow build.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\simba-stop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\simba-stop.ps1 -IncludePostgres

param(
    [switch]$IncludePostgres,
    [switch]$IncludeOllama
)

$ErrorActionPreference = 'Continue'
$freedMb = 0

function Stop-Matching([string]$label, [string]$pattern, [string]$name = 'node.exe') {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern })
    if ($procs.Count -eq 0) { Write-Host ("  {0,-22} not running" -f $label); return }
    foreach ($p in $procs) {
        $mb = [int]($p.WorkingSetSize / 1MB)
        $script:freedMb += $mb
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host ("  {0,-22} stopped {1} process(es)" -f $label, $procs.Count) -ForegroundColor Green
}

Write-Host 'Stopping Simba...' -ForegroundColor Cyan

# The supervisor first, so it does not restart what is about to be stopped.
$task = Get-ScheduledTask -TaskName 'SimbaGateway' -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName 'SimbaGateway' -ErrorAction SilentlyContinue
    Write-Host '  keepalive              stopped' -ForegroundColor Green
} else {
    Write-Host '  keepalive              no scheduled task found'
}
Start-Sleep -Seconds 1

Stop-Matching 'gateway'    '*src/gateway/server.ts*'
Stop-Matching 'supervisor' '*src/supervisor/index.ts*'
Stop-Matching 'simba mcp'  '*src/mcp/server.ts*'
Stop-Matching 'voice worker' '*src\voice\worker.py*' 'python.exe'

# The Electron desktop app, if it is open.
$el = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*simba*desktop*' })
foreach ($p in $el) { $freedMb += [int]($p.WorkingSetSize / 1MB); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($el.Count -gt 0) { Write-Host ("  desktop app            stopped {0} window(s)" -f $el.Count) -ForegroundColor Green }

if ($IncludeOllama) {
    $ol = @(Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue)
    foreach ($p in $ol) { $freedMb += [int]($p.WorkingSet64 / 1MB) }
    $ol | Stop-Process -Force -ErrorAction SilentlyContinue
    if ($ol.Count -gt 0) { Write-Host ("  ollama                 stopped ({0} MB)" -f $freedMb) -ForegroundColor Green }
} else {
    Write-Host '  ollama                 left running (-IncludeOllama to stop)'
}

if ($IncludePostgres) {
    $svc = Get-Service -Name 'PostgreSQL' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        try {
            Stop-Service -Name 'PostgreSQL' -Force -ErrorAction Stop
            Write-Host '  postgres               service stopped' -ForegroundColor Green
        } catch {
            Write-Host '  postgres               needs an elevated shell to stop the service' -ForegroundColor Yellow
        }
    } else {
        Write-Host '  postgres               not running as a service'
    }
} else {
    Write-Host '  postgres               left running (-IncludePostgres to stop)'
}

$os = Get-CimInstance Win32_OperatingSystem
Write-Host ''
Write-Host ("Freed roughly {0} MB. Free RAM now {1:N0} MB of {2:N0} MB." -f `
    $freedMb, ($os.FreePhysicalMemory / 1KB), ($os.TotalVisibleMemorySize / 1KB)) -ForegroundColor Cyan
Write-Host 'Restart with: scripts\simba-start.ps1'
