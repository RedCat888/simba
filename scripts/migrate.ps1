# Applies migrations/*.sql in filename order, once each, inside a transaction.
# Idempotent: already-applied versions are skipped via schema_migrations.
param(
    [string]$Database = 'simba',
    [string]$User     = 'postgres',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$bin  = 'C:\Users\operator\scoop\apps\postgresql\current\bin'
$psql = Join-Path $bin 'psql.exe'
$root = Split-Path -Parent $PSScriptRoot
$migrationDir = Join-Path $root 'migrations'

function Invoke-Psql {
    param([string]$Sql, [string]$File)

    # $ErrorActionPreference is 'Stop' for this script, and in Windows PowerShell
    # `2>&1` on a native executable wraps every stderr line in an ErrorRecord —
    # so a harmless `NOTICE: relation already exists, skipping` was thrown as a
    # terminating error and aborted the whole run partway through. psql's own
    # exit code is the only thing that knows whether it failed, so let it speak.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($File) {
            $out = & $psql -U $User -d $Database -v ON_ERROR_STOP=1 -q -f $File 2>&1
        } else {
            $out = & $psql -U $User -d $Database -v ON_ERROR_STOP=1 -q -t -A -c $Sql 2>&1
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    return $out
}

# 001 creates schema_migrations, so bootstrap detection has to tolerate its absence.
$applied = @()
try {
    $existing = Invoke-Psql -Sql "SELECT to_regclass('schema_migrations') IS NOT NULL;"
    if (($existing | Out-String).Trim() -eq 't') {
        $applied = (Invoke-Psql -Sql "SELECT version FROM schema_migrations;") |
                   ForEach-Object { $_.ToString().Trim() } |
                   Where-Object { $_ }
    }
} catch { }

Get-ChildItem $migrationDir -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    $version = $_.BaseName
    if ($applied -contains $version -and -not $Force) {
        Write-Host "  skip   $version"
        return
    }
    Write-Host "  apply  $version" -ForegroundColor Cyan
    Invoke-Psql -File $_.FullName | Out-Null
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Invoke-Psql -Sql "INSERT INTO schema_migrations (version, checksum) VALUES ('$version','$hash') ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum;" | Out-Null
}

Write-Host "migrations complete" -ForegroundColor Green
