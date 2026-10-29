[CmdletBinding()]
param(
    [switch]$Quiet,
    [ValidateRange(0, 2147483647)]
    [int]$WaitForProcessId = 0,
    [switch]$RemoveManagedPrerequisites
)

$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$installDirFull = [System.IO.Path]::GetFullPath($installDir).TrimEnd('\')
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
if ([System.IO.Path]::GetDirectoryName($installDirFull) -ine $programsRoot -or
    [System.IO.Path]::GetFileName($installDirFull) -ine 'Frosty') {
    throw "Refusing to uninstall from an unexpected path: $installDirFull"
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Frosty'
function Remove-ManagedFrostyArtifacts {
    Remove-ManagedFrostyArtifacts

# Move the calling PowerShell session out of the install directory before scheduling deletion.
Set-Location -LiteralPath $env:TEMP
$escapedInstallDir = $installDirFull.Replace("'", "''")
# Retry for up to ~30 seconds: files can stay locked briefly while Frosty or antivirus releases them.
$deleteCommand = "for (`$i = 0; `$i -lt 30; `$i++) { Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$escapedInstallDir' -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath '$escapedInstallDir')) { break } }"
$encodedDeleteCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($deleteCommand))
$powerShellCommand = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
if ($powerShellCommand) {
    $powerShell = $powerShellCommand.Source
} else {
    $powerShell = Join-Path $PSHOME 'powershell.exe'
}
if (-not (Test-Path -LiteralPath $powerShell)) { throw 'Could not find Windows PowerShell to finish removing the application directory.' }
Start-Process -FilePath $powerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', $encodedDeleteCommand) -WorkingDirectory $env:TEMP -WindowStyle Hidden

Write-Host '[Frosty] Uninstall started. Application files and shortcuts are being removed.' -ForegroundColor Green
Write-Host '[Frosty] Saved projects, source media, and recovery snapshots were preserved. Managed prerequisites and Frosty build artifacts were cleaned up where possible.' -ForegroundColor Cyan
