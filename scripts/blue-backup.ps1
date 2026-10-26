# Bluebird data backup (Windows) -- thin wrapper over scripts/bluebird-backup.js
#
# Why a wrapper: the previous version copied only *top-level files* of the data
# directory. `uploads/` (chat images) and `sticker-repo/` (sticker library) are
# directories and were skipped silently -- the backup reported success while a
# restore would lose every image. There is now one implementation (Node); both
# historical entry points forward to it.
#
#   pwsh scripts/blue-backup.ps1
#   pwsh scripts/blue-backup.ps1 -DataDir 'D:\path\to\Bluebird\server\data' -OutDir 'E:\backups'
#
# Source:   BLUEBIRD_DATA_DIR, else <repo>\server\data
# Dest:     BLUEBIRD_BACKUP_DIR, else <userprofile>\bluebird-backups
# Exit:     0 ok / 1 backup failed / 2 status check failed
#
# NOTE: this file is intentionally ASCII-only. The previous version had to be
# saved with a UTF-8 BOM because PowerShell 5 decodes BOM-less files with the
# ANSI code page and would garble Chinese. Keeping it ASCII removes that trap.

param(
  [string]$DataDir = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Output "x node not found in PATH (the backup CLI needs Node)"
  exit 1
}

$cli = Join-Path $PSScriptRoot 'bluebird-backup.js'
$cliArgs = @($cli)

if ($DataDir) { $cliArgs += @('--data-dir', $DataDir) }
if ($OutDir) { $cliArgs += @('--out-dir', $OutDir) }

& $nodeCmd.Source @cliArgs
exit $LASTEXITCODE
