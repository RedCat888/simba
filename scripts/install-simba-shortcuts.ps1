# Puts Stop Simba and Start Simba on the desktop, beside the existing Simba app
# shortcut. Both run non-elevated; the stop script says so if it needs more.
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell   = New-Object -ComObject WScript.Shell

$items = @(
    @{ Name = 'Stop Simba.lnk';  Script = 'scripts\simba-stop.ps1';  Desc = 'Stop Simba and reclaim its memory'; Icon = 'shell32.dll,27' },
    @{ Name = 'Start Simba.lnk'; Script = 'scripts\simba-start.ps1'; Desc = 'Start Simba back up';               Icon = 'shell32.dll,25' }
)

foreach ($i in $items) {
    $lnk = $shell.CreateShortcut((Join-Path $desktop $i.Name))
    $lnk.TargetPath       = 'powershell.exe'
    $lnk.Arguments        = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$(Join-Path $root $i.Script)`""
    $lnk.WorkingDirectory = $root
    $lnk.Description      = $i.Desc
    $lnk.IconLocation     = $i.Icon
    # Normal window, not hidden: both scripts print what they did, and a stop
    # that silently half-worked is the failure mode worth seeing.
    $lnk.WindowStyle      = 1
    $lnk.Save()
    Write-Output ("  created {0}" -f (Join-Path $desktop $i.Name))
}
