# Private native Windows TEAA installer. PowerShell 5.1, current account.
param([string]$Prefix, [switch]$Desktop, [switch]$AddToPath = $true, [switch]$NoShortcuts, [switch]$NoTerminalMenus, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'TEAA needs Node.js 22.19 or newer. Install it from https://nodejs.org and run this again.'; exit 1 }
$version = & $node.Source --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($version -notmatch '^v(\d+)\.(\d+)\.(\d+)' -or [int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 19)) {
  Write-Error 'TEAA needs Node.js 22.19 or newer.'; exit 1
}
$installArgs = @((Join-Path $here 'src\install.js'))
if ($Prefix) { $installArgs += @('--prefix', $Prefix) }
if ($Desktop) { $installArgs += '--desktop' }
if ($AddToPath) { $installArgs += '--add-to-path' }
if ($NoShortcuts) { $installArgs += '--no-shortcuts' }
if ($NoTerminalMenus) { $installArgs += '--no-terminal-menus' }
if ($Uninstall) { $installArgs += '--uninstall' }
& $node.Source @installArgs
exit $LASTEXITCODE
