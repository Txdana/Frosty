# Frosty self-updater for the native Windows installation.
[CmdletBinding()]
param(
    [ValidateSet('latest')][string]$Channel = 'latest',
    [ValidateRange(0,2147483647)][int]$WaitForProcessId = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$apiHeaders = @{ 'User-Agent' = 'Frosty-Updater'; 'Accept' = 'application/vnd.github+json' }
$apiUrl = 'https://api.github.com/repos/Txdana/Frosty/commits/master'
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'Frosty.exe'))) {
    throw "Frosty is not installed at the expected location: $installDir"
}
if ($WaitForProcessId -gt 0) {
    try {
        $p = Get-Process -Id $WaitForProcessId -ErrorAction Stop
        $expectedExe = [System.IO.Path]::GetFullPath((Join-Path $installDir 'Frosty.exe'))
        if ([System.IO.Path]::GetFullPath($p.Path) -ieq $expectedExe) {
            try { $p.WaitForExit() } catch { }
        }
    } catch { }
}
Write-Host '[Frosty] Resolving the latest master commit...' -ForegroundColor Cyan
$commit = Invoke-RestMethod -Uri $apiUrl -Headers $apiHeaders -TimeoutSec 30
$commitSha = [string]$commit.sha
if ($commitSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'GitHub did not return a valid 40-character commit SHA; update cancelled.' }
$installerUrl = "https://raw.githubusercontent.com/Txdana/Frosty/$commitSha/installer.ps1"
Write-Host "[Frosty] Updating to commit $commitSha. The native app will be rebuilt and tested; this may take a while." -ForegroundColor Cyan
$tempDir = Join-Path $env:TEMP ('frosty-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$installer = Join-Path $tempDir 'installer.ps1'
$previousSourceUrl = $env:FROSTY_SOURCE_URL
$previousRepo = $env:FROSTY_REPO
try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $installer -Headers $apiHeaders -TimeoutSec 60 -UseBasicParsing
    if (-not (Test-Path -LiteralPath $installer) -or (Get-Item -LiteralPath $installer).Length -lt 1024) {
        throw 'Downloaded installer was empty or unexpectedly small.'
    }
    $installerText = Get-Content -LiteralPath $installer -Raw
    foreach ($marker in @('$script:FrostyInstallerRevision', 'Frosty.Desktop.csproj', 'native\CMakeLists.txt', 'managed-prerequisites.json')) {
        if (-not $installerText.Contains($marker)) { throw "Downloaded installer failed its content check (missing expected marker: $marker). Update cancelled." }
    }
    # Pin the source archive to the exact same commit as this installer, not a second moving master snapshot.
    $env:FROSTY_REPO = 'Txdana/Frosty'
    $env:FROSTY_SOURCE_URL = "https://github.com/Txdana/Frosty/archive/${commitSha}.zip"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE -ne 0) { throw "Frosty update failed with exit code $LASTEXITCODE. The installer should preserve the previous app if the new build could not be staged." }
    Write-Host "[Frosty] Update completed from commit $commitSha." -ForegroundColor Green
} finally {
    if ($null -eq $previousSourceUrl) { Remove-Item Env:FROSTY_SOURCE_URL -ErrorAction SilentlyContinue } else { $env:FROSTY_SOURCE_URL = $previousSourceUrl }
    if ($null -eq $previousRepo) { Remove-Item Env:FROSTY_REPO -ErrorAction SilentlyContinue } else { $env:FROSTY_REPO = $previousRepo }
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
