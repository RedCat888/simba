# Puts a Simba shortcut on the desktop that opens the app window.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launch = Join-Path $root 'scripts\launch-desktop.ps1'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Simba.lnk'

$w = New-Object -ComObject WScript.Shell
$lnk = $w.CreateShortcut($lnkPath)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launch`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7
$lnk.Description = 'Simba desktop'
$lnk.Save()
Write-Output $lnkPath
