[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) { Write-Host "`n[Frosty] $Message" -ForegroundColor Cyan }
$packageRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'Frosty.exe'))) { throw 'Run Install-Frosty.ps1 from the extracted native Frosty release ZIP folder containing Frosty.exe.' }
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'Uninstall-Frosty.ps1'))) { throw 'This release package does not contain Uninstall-Frosty.ps1. Download a current native release package and retry.' }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$ffmpegHelper = Join-Path $packageRoot 'install-ffmpeg.ps1'
if (-not (Test-Path -LiteralPath $ffmpegHelper)) {
    $ffmpegHelper = Join-Path $packageRoot 'scripts\install-ffmpeg.ps1'
}

Write-Step 'Checking FFmpeg dependency'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ffmpegHelper -CheckOnly
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Frosty uses FFmpeg as a separately installed command-line dependency. WinGet declares Gyan.FFmpeg as GPL-3.0; Frosty remains Apache-2.0 and does not bundle that binary.' -ForegroundColor Yellow
    $answer = Read-Host 'Install Gyan.FFmpeg through WinGet now? [Y/n]'
    if ($answer -notmatch '^(n|no)$') {
        $ffmpegWasInstalled = $false
        try { $ffmpegWasInstalled = [bool]((& winget.exe list --id Gyan.FFmpeg --exact --disable-interactivity 2>$null | Out-String) -match 'Gyan.FFmpeg') } catch { }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ffmpegHelper -InstallIfMissing
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'FFmpeg setup failed. Frosty will still be installed, but media features may be unavailable.' -ForegroundColor Yellow
        } elseif (-not $ffmpegWasInstalled) {
            $managedRoot = Join-Path $env:LOCALAPPDATA 'Frosty'; New-Item -ItemType Directory -Force -Path $managedRoot | Out-Null
            $manifestPath = Join-Path $managedRoot 'managed-prerequisites.json'
            $manifest = if (Test-Path -LiteralPath $manifestPath) { try { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { [pscustomobject]@{ wingetPackages=@() } } } else { [pscustomobject]@{ wingetPackages=@() } }
            $ids = @(@($manifest.wingetPackages | Where-Object { $_ }) + 'Gyan.FFmpeg' | Select-Object -Unique)
            Set-Content -LiteralPath $manifestPath -Value (@{ wingetPackages=$ids } | ConvertTo-Json -Depth 4) -Encoding utf8
        }
    } else {
        Write-Host 'Skipping FFmpeg. Install it later and put it on PATH before using media operations.' -ForegroundColor Yellow
    }
}

Write-Step "Installing Frosty to $installDir"
if ($packageRoot.TrimEnd('\\') -ne $installDir.TrimEnd('\\')) {
    $installedExe = [System.IO.Path]::GetFullPath((Join-Path $installDir 'Frosty.exe'))
    Get-Process -Name 'Frosty' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ([System.IO.Path]::GetFullPath($_.Path) -ieq $installedExe) {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Get-ChildItem -LiteralPath $packageRoot -Force | Where-Object { $_.Name -notin @('Install-Frosty.ps1', 'Install-Frosty.cmd') } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $installDir -Recurse -Force
    }
}

$uninstallScript = Join-Path $installDir 'Uninstall-Frosty.ps1'
if (-not (Test-Path -LiteralPath $uninstallScript)) { throw 'The Frosty uninstaller was not copied to the installation directory.' }
$versionFile = Join-Path $installDir 'FROSTY_VERSION.txt'
$displayVersion = '1.3.0'
if (Test-Path -LiteralPath $versionFile) {
    $candidateVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($candidateVersion)) { $displayVersion = $candidateVersion }
}
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Frosty'
New-Item -Path $uninstallKey -Force | Out-Null
$uninstallCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninstallScript + '"'
$quietUninstallCommand = $uninstallCommand + ' -Quiet'
$registryValues = @{
    DisplayName = 'Frosty'
    DisplayVersion = $displayVersion
    Publisher = 'Txdana'
    InstallLocation = $installDir
    DisplayIcon = (Join-Path $installDir 'Frosty.exe')
    UninstallString = $uninstallCommand
    QuietUninstallString = $quietUninstallCommand
    URLInfoAbout = 'https://github.com/Txdana/Frosty'
    InstallDate = (Get-Date -Format 'yyyyMMdd')
}
foreach ($entry in $registryValues.GetEnumerator()) {
    New-ItemProperty -Path $uninstallKey -Name $entry.Key -Value ([string]$entry.Value) -PropertyType String -Force | Out-Null
}
New-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shimDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shimPath = Join-Path $shimDir 'frosty.cmd'
if (Test-Path -LiteralPath $shimDir) {
    $canReplaceShim = -not (Test-Path -LiteralPath $shimPath)
    if (-not $canReplaceShim) { try { $canReplaceShim = (Get-Content -LiteralPath $shimPath -Raw) -match 'Programs\\Frosty\\Update-Frosty\.ps1' } catch { } }
    if ($canReplaceShim) { Copy-Item -LiteralPath (Join-Path $installDir 'frosty.cmd') -Destination $shimPath -Force }
    else { Write-Warning "A different command already exists at $shimPath; leaving it untouched. You can run the updater directly from $installDir." }
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$links = @((Join-Path $startMenu 'Frosty.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'))
foreach ($linkPath in $links) {
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = Join-Path $installDir 'Frosty.exe'
    $shortcut.WorkingDirectory = $installDir
    $shortcut.Description = 'Frosty native C++/WPF video editor'
    $shortcut.IconLocation = Join-Path $installDir 'Frosty.exe'
    $shortcut.Save()
}
Write-Step 'Installation complete'
Start-Process -FilePath (Join-Path $installDir 'Frosty.exe') -WorkingDirectory $installDir
Write-Host "Installed: $installDir\Frosty.exe" -ForegroundColor Green
