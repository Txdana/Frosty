# Frosty self-updater for the native Windows installation.
[CmdletBinding()]
param(
    [Parameter(Position=0)][ValidateSet('--update')][string]$Command='--update',
    [Parameter(Position=1)][ValidateSet('latest')][string]$Channel='latest',
    [ValidateRange(0,2147483647)][int]$WaitForProcessId=0
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$installDir=Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$installerUrl='https://raw.githubusercontent.com/Txdana/Frosty/master/installer.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'Frosty.exe'))) {
    throw "Frosty is not installed at the expected location: $installDir"
}
if ($WaitForProcessId -gt 0) {
    try {
        $p=Get-Process -Id $WaitForProcessId -ErrorAction Stop
        try { $p.WaitForExit() } catch { }
    } catch { }
}
Write-Host "[Frosty] Updating to the latest master build. This rebuilds and tests the native app; it may take a while." -ForegroundColor Cyan
$tempDir=Join-Path $env:TEMP ('frosty-update-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$installer=Join-Path $tempDir 'installer.ps1'
try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $installer -UseBasicParsing
    if (-not (Test-Path -LiteralPath $installer) -or (Get-Item -LiteralPath $installer).Length -lt 1024) {
        throw 'Downloaded updater bootstrap was empty or unexpectedly small.'
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE -ne 0) { throw "Frosty update failed with exit code $LASTEXITCODE. The installer should preserve the previous app if the new build could not be staged." }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
