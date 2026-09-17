# Create junction mirrors of @deepseek-ai/* so esbuild can resolve them at BUILD time.
#
# The reference implementation links from a pnpm workspace; we do not have one,
# so we link straight from the dsh install / profile store. The produced
# lib/index.js is self-contained, so these links are only needed to build.
#
# NOTE: ASCII only on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI unless
# the file carries a UTF-8 BOM, which mangles non-ASCII text into parse errors.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/link-dsh.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/link-dsh.ps1 -Source "D:\x\node_modules\@deepseek-ai"

param(
  [string]$Source = ""
)

$ErrorActionPreference = 'Stop'

$candidates = @()
if ($Source) { $candidates += $Source }
$candidates += @(
  (Join-Path $env:USERPROFILE ".dsh\profiles\node_modules\@deepseek-ai"),
  (Join-Path (npm root -g) "@deepseek-ai\dsh\node_modules\@deepseek-ai")
)

$src = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $src = $c; break }
}

if (-not $src) {
  Write-Host "ERROR: no @deepseek-ai source directory found. Tried:"
  $candidates | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Write-Host "source: $src"

$linkRoot = Join-Path $PSScriptRoot "..\node_modules\@deepseek-ai"
New-Item -ItemType Directory $linkRoot -Force | Out-Null

$created = 0
$skipped = 0

Get-ChildItem $src -Directory | ForEach-Object {
  $link = Join-Path $linkRoot $_.Name
  if (Test-Path $link) { $script:skipped++ }
  else {
    New-Item -ItemType Junction -Path $link -Target $_.FullName | Out-Null
    $script:created++
  }
}

Write-Host "created $created new junctions, $skipped already existed"
Write-Host "total: $((Get-ChildItem $linkRoot).Count) mirrors in $linkRoot"
