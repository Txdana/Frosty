# Install / re-install / uninstall / re-uninstall lifecycle test for the native Frosty release package.
# It runs the real scripts shipped in the package (Install-Frosty.ps1 and Uninstall-Frosty.ps1) against an
# isolated LOCALAPPDATA/APPDATA, then asserts files, shortcuts and the Add/Remove Programs entry.
#
# The Add/Remove Programs entry lives in HKCU and cannot be sandboxed, so this test only runs on CI
# (GITHUB_ACTIONS=true) or when FROSTY_LIFECYCLE_TEST=1 is set. It never runs on a normal `npm test`.
[CmdletBinding()]
param([string]$PackageDir = 'dist/native-windows-e2e')
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -and $env:FROSTY_LIFECYCLE_TEST -ne '1') {
    Write-Host '[Lifecycle] Skipped: set FROSTY_LIFECYCLE_TEST=1 to run (it writes the HKCU uninstall entry for Frosty).' -ForegroundColor Yellow
    exit 0
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Join-Path $root $PackageDir
foreach ($required in @('Frosty.exe', 'frosty_core.dll', 'Install-Frosty.ps1', 'Uninstall-Frosty.ps1', 'Cleanup-Frosty-Testing.ps1', 'Update-Frosty.ps1', 'frosty.cmd', 'install-ffmpeg.ps1', 'LICENSE', 'NOTICE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $required))) { throw "Lifecycle test needs '$required' in $package. Run scripts/build-native.ps1 first." }
}

$sandbox = Join-Path $env:TEMP ('frosty-lifecycle-' + [guid]::NewGuid().ToString('N'))
$originalLocal = $env:LOCALAPPDATA
$originalRoaming = $env:APPDATA
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Frosty'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'

function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Lifecycle assertion failed: $Message" } }
function Invoke-Script([string]$Path, [string[]]$ScriptArgs = @()) {
    # Out-Host keeps the child's console output out of the function's return value; only the exit code is returned.
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path @ScriptArgs | Out-Host
    return [int]$LASTEXITCODE
}

try {
    $env:LOCALAPPDATA = Join-Path $sandbox 'Local'
    $env:APPDATA = Join-Path $sandbox 'Roaming'
    New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:APPDATA | Out-Null
    $installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
    $startMenuLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Frosty.lnk'

    Write-Host '[Lifecycle 1/5] Fresh install...' -ForegroundColor Cyan
    Assert-That ((Invoke-Script (Join-Path $package 'Install-Frosty.ps1')) -eq 0) 'Install-Frosty.ps1 exited non-zero'
    foreach ($file in @('Frosty.exe', 'frosty_core.dll', 'Uninstall-Frosty.ps1', 'LICENSE', 'NOTICE')) {
        Assert-That (Test-Path -LiteralPath (Join-Path $installDir $file)) "installed file missing: $file"
    }
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $installDir 'ffmpeg.exe'))) 'FFmpeg must not be bundled into the install directory'
    Assert-That (Test-Path -LiteralPath (Join-Path $installDir 'Update-Frosty.ps1')) 'updater script missing from installation'
    Assert-That (Test-Path -LiteralPath (Join-Path $installDir 'Cleanup-Frosty-Testing.ps1')) 'testing cleanup helper missing from installation'
    Assert-That (Test-Path -LiteralPath (Join-Path $installDir 'frosty.cmd')) 'terminal command shim missing from installation'
    Assert-That (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\frosty.cmd')) 'PATH command shim missing'
    Assert-That (Test-Path -LiteralPath $startMenuLink) 'Start Menu shortcut missing'
    Assert-That (Test-Path -LiteralPath $uninstallKey) 'Add/Remove Programs entry missing'
    $entry = Get-ItemProperty -LiteralPath $uninstallKey
    Assert-That ($entry.DisplayName -eq 'Frosty') 'uninstall entry DisplayName is wrong'
    Assert-That ($entry.UninstallString -like '*Uninstall-Frosty.ps1*') 'uninstall entry does not point at Uninstall-Frosty.ps1'
    Assert-That ($entry.InstallLocation -eq $installDir) 'uninstall entry InstallLocation is wrong'

    Write-Host '[Lifecycle 2/5] Repeat install over the existing install (must be idempotent)...' -ForegroundColor Cyan
    Assert-That ((Invoke-Script (Join-Path $package 'Install-Frosty.ps1')) -eq 0) 'second Install-Frosty.ps1 run exited non-zero'
    Assert-That (Test-Path -LiteralPath (Join-Path $installDir 'Frosty.exe')) 'Frosty.exe missing after re-install'

    Write-Host '[Lifecycle 3/5] Quiet uninstall (also closes the Frosty.exe that setup launched)...' -ForegroundColor Cyan
    Assert-That ((Invoke-Script (Join-Path $installDir 'Uninstall-Frosty.ps1') @('-Quiet')) -eq 0) 'Uninstall-Frosty.ps1 -Quiet exited non-zero'
    $deadline = (Get-Date).AddSeconds(60)
    while ((Test-Path -LiteralPath $installDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    Assert-That (-not (Test-Path -LiteralPath $installDir)) 'install directory still exists 60s after uninstall'
    Assert-That (-not (Test-Path -LiteralPath $startMenuLink)) 'Start Menu shortcut still exists after uninstall'
    Assert-That (-not (Test-Path -LiteralPath $desktopLink)) 'Desktop shortcut still exists after uninstall'
    Assert-That (-not (Test-Path -LiteralPath $uninstallKey)) 'Add/Remove Programs entry still exists after uninstall'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\frosty.cmd'))) 'PATH command shim still exists after uninstall'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\Frosty'))) 'Frosty install directory still exists after uninstall'

    Write-Host '[Lifecycle 4/5] Uninstall when already removed (must succeed and stay clean)...' -ForegroundColor Cyan
    $uninstaller = Join-Path $package 'Uninstall-Frosty.ps1'
    Assert-That ((Invoke-Script $uninstaller @('-Quiet')) -eq 0) 'uninstalling an already-removed app exited non-zero'

    Write-Host '[Lifecycle 5/5] PASS: install, re-install, uninstall and repeat uninstall all behaved correctly.' -ForegroundColor Green
} finally {
    $env:LOCALAPPDATA = $originalLocal
    $env:APPDATA = $originalRoaming
    Get-Process -Name 'Frosty' -ErrorAction SilentlyContinue | ForEach-Object {
        try { if ($_.Path -and $_.Path.StartsWith($sandbox, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } } catch { }
    }
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $desktopLink -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
