[CmdletBinding()]
param(
    [switch]$Quiet,
    [ValidateRange(0, 2147483647)]
    [int]$WaitForProcessId = 0
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
if (-not (Test-Path -LiteralPath $installDirFull)) {
    $staleStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $staleShortcuts = @(
        (Join-Path $staleStartMenu 'Frosty.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk')
    )
    foreach ($shortcut in $staleShortcuts) {
        Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '[Frosty] The application directory is already absent. Removed any stale shortcuts and uninstall registration.' -ForegroundColor Yellow
    exit 0
}

if (-not $Quiet) {
    Add-Type -AssemblyName System.Windows.Forms
    $message = @"
This will remove the Frosty application and its Start Menu/Desktop shortcuts from this Windows account.

Saved .frosty projects, original media, recovery data, the source snapshot, FFmpeg, and build prerequisites will be kept. FFmpeg is a separate dependency and is not removed.

Continue with uninstall?
"@
    $answer = [System.Windows.Forms.MessageBox]::Show(
        $message,
        'Uninstall Frosty',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-Host '[Frosty] Uninstall cancelled.' -ForegroundColor Yellow
        exit 0
    }
}

$exePath = [System.IO.Path]::GetFullPath((Join-Path $installDirFull 'Frosty.exe'))
if ($WaitForProcessId -gt 0) {
    try {
        $waiting = Get-Process -Id $WaitForProcessId -ErrorAction Stop
        $waitingPath = [System.IO.Path]::GetFullPath($waiting.Path)
        if ($waitingPath -ieq $exePath) {
            try { $waiting | Wait-Process -Timeout 45 -ErrorAction SilentlyContinue } catch { }
            $waiting = Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue
            if ($waiting) {
                try {
                    if ([System.IO.Path]::GetFullPath($waiting.Path) -ieq $exePath) {
                        Stop-Process -Id $WaitForProcessId -Force -ErrorAction SilentlyContinue
                    }
                } catch { }
            }
        }
    } catch { }
}

# Close only Frosty processes running from this exact installation directory.
Get-Process -Name 'Frosty' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        if ([System.IO.Path]::GetFullPath($_.Path) -ieq $exePath) {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcuts = @(
    (Join-Path $startMenu 'Frosty.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk')
)
foreach ($shortcut in $shortcuts) {
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue

# Move the calling PowerShell session out of the install directory before scheduling deletion.
Set-Location -LiteralPath $env:TEMP
$escapedInstallDir = $installDirFull.Replace("'", "''")
$deleteCommand = "Start-Sleep -Seconds 2; Remove-Item -LiteralPath '$escapedInstallDir' -Recurse -Force -ErrorAction SilentlyContinue"
$encodedDeleteCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($deleteCommand))
$powerShell = Join-Path $PSHOME 'powershell.exe'
Start-Process -FilePath $powerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', $encodedDeleteCommand) -WorkingDirectory $env:TEMP -WindowStyle Hidden

Write-Host '[Frosty] Uninstall started. Application files and shortcuts are being removed.' -ForegroundColor Green
Write-Host '[Frosty] Saved projects, source media, recovery data, the source snapshot, FFmpeg, and build tools were left untouched.' -ForegroundColor Cyan
