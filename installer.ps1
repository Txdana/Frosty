# Frosty one-command Windows installer.
# Run: irm https://raw.githubusercontent.com/Txdana/Frosty/master/installer.ps1 | iex
# This script builds Frosty from the selected source; it does not download an unverified app EXE.
# No Electron fallback: failure to compile the native app is a hard installation failure.
# Optional overrides:
#   $env:FROSTY_REPO = 'owner/repository'
#   $env:FROSTY_SOURCE_URL = 'https://.../source.zip'
#   $env:FROSTY_SOURCE_DIR = 'C:\path\to\Frosty'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Write-Step([string]$Message) { Write-Host "`n[Frosty] $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "[Frosty] $Message" -ForegroundColor Yellow }
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    $parts = @($env:Path, $machinePath, $userPath, $wingetLinks) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $env:Path = ($parts | Select-Object -Unique) -join ';'
}

function Get-WinGetPath {
    $cmd = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command 'winget' -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    return $null
}

function Invoke-WinGetInstall([string]$Id, [string[]]$ExtraArgs = @()) {
    $winget = Get-WinGetPath
    if (-not $winget) {
        throw 'Windows Package Manager (WinGet) is missing. Install or update App Installer from Microsoft Store, then rerun this command.'
    }
    Write-Step "Installing prerequisite: $Id"
    $wingetArgs = @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') + $ExtraArgs
    & $winget @wingetArgs
    $code = $LASTEXITCODE
    Refresh-ProcessPath
    if ($code -ne 0) { throw "WinGet failed to install $Id (exit code $code). Resolve the WinGet error and rerun the same installer command." }
}

function Test-Node20 {
    if (-not (Test-Command 'node') -or -not (Test-Command 'npm')) { return $false }
    try { $major = [int]((node -p "process.versions.node.split('.')[0]").Trim()); return ($major -ge 20) } catch { return $false }
}

function Test-DotNet8Sdk {
    if (-not (Test-Command 'dotnet')) { return $false }
    try { return ((& dotnet --list-sdks 2>$null) -join "`n") -match '(^|\r?\n)8\.' } catch { return $false }
}


function Test-Python3 {
    foreach ($name in @('py', 'python3', 'python')) {
        if (Test-Command $name) {
            try {
                if ($name -eq 'py') { & py -3 --version *> $null } else { & $name --version *> $null }
                if ($LASTEXITCODE -eq 0) { return $true }
            } catch { }
        }
    }
    return $false
}

function Get-VsWherePath {
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-VisualStudioInstallPaths {
    $paths = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $vswhere = Get-VsWherePath
    if ($vswhere) {
        $found = & $vswhere -all -products '*' -property installationPath 2>$null
        foreach ($entry in @($found)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
                $candidate = ([string]$entry).Trim()
                if ((Test-Path -LiteralPath $candidate) -and $seen.Add($candidate)) { $paths.Add($candidate) }
            }
        }
    }

    # vswhere can be absent or fail to enumerate an incomplete Build Tools install.
    # Visual Studio Setup's instance registry is another supported source of install paths.
    $instanceRoots = @(
        'HKLM:\SOFTWARE\Microsoft\VisualStudio\Setup\Instances',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\Setup\Instances'
    )
    foreach ($root in $instanceRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $instance = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            $candidate = [string]$instance.installationPath
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and
                (Test-Path -LiteralPath $candidate) -and $seen.Add($candidate)) {
                $paths.Add($candidate)
            }
        }
    }

    $defaultBuildTools = $null
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $defaultBuildTools = Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools'
    }
    if ($defaultBuildTools -and (Test-Path -LiteralPath $defaultBuildTools) -and $seen.Add($defaultBuildTools)) {
        $paths.Insert(0, $defaultBuildTools)
    }
    return @($paths)
}

function Test-WinGetPackageInstalled([string]$Id) {
    $winget = Get-WinGetPath
    if (-not $winget) { return $false }
    try {
        $output = (& $winget list --id $Id --exact --disable-interactivity 2>&1 | Out-String)
        foreach ($line in ($output -split '\r?\n')) {
            if ($line -match [regex]::Escape($Id) -and $line -notmatch 'No installed package found') { return $true }
        }
    } catch { }
    return $false
}

function Ensure-VisualCppToolchain {
    $vswhere = Get-VsWherePath
    $validInstall = $null
    if ($vswhere) {
        $matches = & $vswhere -all -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($matches) { $validInstall = ($matches | Select-Object -First 1).Trim() }
    }
    if ($validInstall -and (Test-Path -LiteralPath $validInstall)) {
        Write-Host "Visual Studio C++ toolchain found: $validInstall" -ForegroundColor Green
        return
    }

    $instances = @(Get-VisualStudioInstallPaths)
    $existing = $null
    if ($instances.Count -gt 0) {
        # Prefer Build Tools over a full Visual Studio IDE instance when both are installed.
        $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        $buildToolsDefault = if ($programFilesX86) { Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools' } else { $null }
        if ($buildToolsDefault -and $instances -contains $buildToolsDefault) {
            $existing = $buildToolsDefault
        } else {
            $existing = $instances | Select-Object -First 1
        }
    }

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $setupCandidates = @()
    if ($programFilesX86) { $setupCandidates += Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\setup.exe' }
    if ($env:ProgramFiles) { $setupCandidates += Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\setup.exe' }
    $setup = $setupCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($existing) {
        if (-not $setup) {
            throw "Visual Studio is installed at '$existing', but the Visual Studio Installer setup.exe was not found. Open Visual Studio Installer, repair Build Tools 2022, and select Desktop development with C++."
        }
        Write-Step "Adding the required C++ workload and Windows SDK to the existing Visual Studio instance: $existing"
        & $setup modify --installPath $existing --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait --norestart
        $setupExitCode = $LASTEXITCODE
        if ($setupExitCode -notin @(0, 3010)) {
            throw "Visual Studio Installer could not add the C++ workload (exit code $setupExitCode). Open Visual Studio Installer, choose Build Tools 2022 > Modify, select Desktop development with C++, and finish the installation. Then rerun this Frosty installer."
        }
        if ($setupExitCode -eq 3010) {
            Write-Note 'Visual Studio setup requested a restart. Continuing verification; reboot Windows before building if MSVC remains unavailable.'
        }
    } elseif (Test-WinGetPackageInstalled 'Microsoft.VisualStudio.2022.BuildTools') {
        throw "WinGet reports Visual Studio Build Tools 2022 is already installed, but vswhere and the Visual Studio Setup registry did not expose a usable instance. Frosty will not try to upgrade it blindly. Open Visual Studio Installer, choose Build Tools 2022 > Modify (or Repair), select Desktop development with C++ including MSVC x64/x86 tools and a Windows 10/11 SDK, finish setup, then rerun this installer."
    } else {
        $override = '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        Invoke-WinGetInstall 'Microsoft.VisualStudio.2022.BuildTools' @('--override', $override)
    }

    Refresh-ProcessPath
    $vswhere = Get-VsWherePath
    if (-not $vswhere) {
        throw 'Visual Studio setup completed but vswhere.exe is still missing. Open Visual Studio Installer, finish or repair Build Tools 2022, ensure Desktop development with C++ is installed, then rerun Frosty setup.'
    }
    $valid = & $vswhere -all -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if (-not $valid) {
        throw 'The MSVC C++ toolchain was not detected after Visual Studio setup. In Visual Studio Installer, modify Build Tools 2022 and select Desktop development with C++, including MSVC x64/x86 build tools and a Windows 10/11 SDK.'
    }
    Write-Host "Visual Studio C++ toolchain ready: $(($valid | Select-Object -First 1).Trim())" -ForegroundColor Green
}

function Ensure-BoostHeaders {
    $defaultVcpkg = Join-Path $env:LOCALAPPDATA 'Frosty\toolchain\vcpkg'
    $vcpkgRoot = $env:VCPKG_ROOT
    if ([string]::IsNullOrWhiteSpace($vcpkgRoot) -or -not (Test-Path (Join-Path $vcpkgRoot 'vcpkg.exe'))) { $vcpkgRoot = $defaultVcpkg }
    $boostHeader = Join-Path $vcpkgRoot 'installed\x64-windows\include\boost\property_tree\ptree.hpp'
    if (Test-Path -LiteralPath $boostHeader) {
        $env:VCPKG_ROOT = $vcpkgRoot
        $env:BOOST_ROOT = Join-Path $vcpkgRoot 'installed\x64-windows\include'
        return
    }

    Write-Step 'Installing Boost.PropertyTree headers with Microsoft vcpkg'
    $toolDir = Join-Path $env:LOCALAPPDATA 'Frosty\toolchain'
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    if (-not (Test-Path (Join-Path $vcpkgRoot 'bootstrap-vcpkg.bat'))) {
        $downloadZip = Join-Path $env:TEMP ('vcpkg-' + [guid]::NewGuid().ToString('N') + '.zip')
        $extractDir = Join-Path $env:TEMP ('vcpkg-src-' + [guid]::NewGuid().ToString('N'))
        try {
            Invoke-WebRequest -Uri 'https://github.com/microsoft/vcpkg/archive/refs/heads/master.zip' -OutFile $downloadZip -UseBasicParsing
            Expand-Archive -LiteralPath $downloadZip -DestinationPath $extractDir -Force
            $source = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
            if (-not $source -or -not (Test-Path (Join-Path $source.FullName 'bootstrap-vcpkg.bat'))) { throw 'The official vcpkg source archive was not in the expected format.' }
            if (Test-Path -LiteralPath $vcpkgRoot) { Remove-Item -LiteralPath $vcpkgRoot -Recurse -Force }
            Move-Item -LiteralPath $source.FullName -Destination $vcpkgRoot
        } finally {
            Remove-Item -LiteralPath $downloadZip -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $bootstrap = Join-Path $vcpkgRoot 'bootstrap-vcpkg.bat'
    & $bootstrap -disableMetrics
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $vcpkgRoot 'vcpkg.exe'))) { throw 'vcpkg bootstrap failed.' }
    $env:VCPKG_ROOT = $vcpkgRoot
    $env:VCPKG_DISABLE_METRICS = '1'
    & (Join-Path $vcpkgRoot 'vcpkg.exe') install 'boost-property-tree:x64-windows' --disable-metrics
    if ($LASTEXITCODE -ne 0) { throw 'vcpkg could not install Boost.PropertyTree. Review the error above and rerun the installer.' }
    if (-not (Test-Path -LiteralPath $boostHeader)) { throw 'Boost.PropertyTree installation finished but the required header was not found.' }
    $env:BOOST_ROOT = Join-Path $vcpkgRoot 'installed\x64-windows\include'
}

function Ensure-ExternalFfmpeg([string]$SourceRoot) {
    Write-Step 'Checking external FFmpeg prerequisite'
    $helper = Join-Path $SourceRoot 'scripts\install-ffmpeg.ps1'
    if (-not (Test-Path -LiteralPath $helper)) { throw 'Frosty FFmpeg setup helper is missing from the source tree.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -CheckOnly
    if ($LASTEXITCODE -eq 0) { return }

    if (-not (Get-WinGetPath)) { throw 'FFmpeg is required and WinGet is unavailable. Install App Installer or install a trusted FFmpeg build manually, then rerun.' }
    Write-Host ''
    Write-Host 'Frosty does not bundle FFmpeg. The suggested Gyan.FFmpeg WinGet package is a separate third-party package and its manifest declares GPL-3.0.' -ForegroundColor Yellow
    $answer = Read-Host 'Install FFmpeg now? [Y/n]'
    if ($answer -match '^(n|no)$') { throw 'FFmpeg was not installed. Install a compatible FFmpeg build and rerun the Frosty installer.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -InstallIfMissing
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg installation or verification failed.' }
    Refresh-ProcessPath
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg did not pass its verification check after installation.' }
}

$repo = $env:FROSTY_REPO
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = 'Txdana/Frosty' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid FROSTY_REPO '$repo'. Use owner/repository." }
$sourceDirectory = $env:FROSTY_SOURCE_DIR
$sourceUrl = $env:FROSTY_SOURCE_URL
if ([string]::IsNullOrWhiteSpace($sourceUrl)) { $sourceUrl = "https://github.com/$repo/archive/refs/heads/master.zip" }

$stage = Join-Path $env:TEMP ('frosty-src-' + [guid]::NewGuid().ToString('N'))
$sourceZip = Join-Path $env:TEMP ('frosty-source-' + [guid]::NewGuid().ToString('N') + '.zip')
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$sourceSnapshot = Join-Path $env:LOCALAPPDATA 'Frosty\source-build\project'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    Write-Step 'Preparing Frosty source'
    if (-not [string]::IsNullOrWhiteSpace($sourceDirectory)) {
        if (-not (Test-Path (Join-Path $sourceDirectory 'package.json'))) { throw 'FROSTY_SOURCE_DIR must point to the project root containing package.json.' }
        $src = (Resolve-Path -LiteralPath $sourceDirectory).Path
    } else {
        Invoke-WebRequest -Uri $sourceUrl -OutFile $sourceZip -UseBasicParsing
        if (-not (Test-Path -LiteralPath $sourceZip) -or (Get-Item -LiteralPath $sourceZip).Length -lt 1024) { throw 'The source download is empty or unexpectedly small.' }
        Expand-Archive -LiteralPath $sourceZip -DestinationPath $stage -Force
        $projectFile = Get-ChildItem -LiteralPath $stage -Filter 'Frosty.Desktop.csproj' -Recurse -File | Select-Object -First 1
        if (-not $projectFile) { throw 'The downloaded source is not the expected Frosty native project.' }
        $src = (Resolve-Path (Join-Path $projectFile.Directory.FullName '..\..')).Path
    }
    $pkgFile = Join-Path $src 'package.json'
    $cmakeFile = Join-Path $src 'native\CMakeLists.txt'
    $csprojFile = Join-Path $src 'windows\Frosty.Desktop\Frosty.Desktop.csproj'
    if (-not (Test-Path $pkgFile) -or -not (Test-Path $cmakeFile) -or -not (Test-Path $csprojFile)) { throw 'Source tree is missing required native Frosty files. Use the official repository source ZIP or a full checkout.' }
    $pkg = Get-Content -LiteralPath $pkgFile -Raw | ConvertFrom-Json
    if ($pkg.name -ne 'frosty') { throw "Downloaded source package name is '$($pkg.name)', not 'frosty'." }
    if (-not (Test-Path (Join-Path $src 'LICENSE'))) { throw 'Source tree is missing its LICENSE file.' }

    Write-Step 'Checking and installing build prerequisites (this can download several GB)'
    if (-not (Test-Node20)) { Invoke-WinGetInstall 'OpenJS.NodeJS.LTS' }
    if (-not (Test-Node20)) { throw 'Node.js 20+ was not available after WinGet installation. Open a new PowerShell window and rerun.' }

    if (-not (Test-Command 'cmake')) { Invoke-WinGetInstall 'Kitware.CMake' }
    if (-not (Test-Command 'cmake')) { throw 'CMake is missing after installation. Open a new terminal and rerun.' }
    $cmakeVersionText = (& cmake --version | Select-Object -First 1) -replace '^cmake version ', ''
    try { $cmakeVersion = [version]$cmakeVersionText } catch { throw "Could not parse the installed CMake version '$cmakeVersionText'. Update CMake and rerun." }
    if ($cmakeVersion -lt [version]'3.20') { Invoke-WinGetInstall 'Kitware.CMake' }
    if (-not (Test-Command 'cmake')) { throw 'CMake is missing after installation. Open a new terminal and rerun.' }

    if (-not (Test-DotNet8Sdk)) { Invoke-WinGetInstall 'Microsoft.DotNet.SDK.8' }
    if (-not (Test-DotNet8Sdk)) { throw '.NET 8 SDK was not found after WinGet installation. Open a new terminal and rerun.' }

    if (-not (Test-Python3)) { Invoke-WinGetInstall 'Python.Python.3.13' }
    if (-not (Test-Python3)) { throw 'Python 3 was not found after WinGet installation. Install Python 3.13 and ensure the Python launcher is on PATH.' }

    Ensure-VisualCppToolchain
    Ensure-BoostHeaders
    Ensure-ExternalFfmpeg -SourceRoot $src

    $env:VCPKG_ROOT = $env:VCPKG_ROOT
    $env:BOOST_ROOT = $env:BOOST_ROOT
    Write-Step 'Running Frosty regression tests'
    Push-Location $src
    try {
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'Frosty regression tests failed. No app was installed; fix the failure and rerun.' }
        Write-Step 'Building native C++ engine and self-contained WPF application'
        & (Join-Path $src 'scripts\build-native.ps1') -Configuration Release -Runtime 'win-x64' -OutputDirectory 'dist/native-windows'
        if ($LASTEXITCODE -ne 0) { throw 'Native C++/WPF build failed. No app was installed.' }
    } finally { Pop-Location }

    $published = Join-Path $src 'dist\native-windows'
    $exe = Join-Path $published 'Frosty.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw 'Build completed without producing dist/native-windows/Frosty.exe.' }
    foreach ($forbidden in @('ffmpeg.exe', 'ffprobe.exe')) {
        if (Test-Path (Join-Path $published $forbidden)) { throw "Refusing to install a bundled $forbidden. FFmpeg must remain separately installed under its own license." }
    }

    Write-Step "Installing Frosty to $installDir"
    Get-Process -Name 'Frosty' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Copy-Item -Path (Join-Path $published '*') -Destination $installDir -Recurse -Force

    $uninstallScript = Join-Path $installDir 'Uninstall-Frosty.ps1'
    if (-not (Test-Path -LiteralPath $uninstallScript)) { throw 'The native build did not include Uninstall-Frosty.ps1; refusing to register an incomplete installation.' }
    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Frosty'
    New-Item -Path $uninstallKey -Force | Out-Null
    $uninstallCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninstallScript + '"'
    $registryValues = @{
        DisplayName = 'Frosty'
        DisplayVersion = [string]$pkg.version
        Publisher = 'Txdana'
        InstallLocation = $installDir
        DisplayIcon = (Join-Path $installDir 'Frosty.exe')
        UninstallString = $uninstallCommand
        QuietUninstallString = ($uninstallCommand + ' -Quiet')
        URLInfoAbout = 'https://github.com/Txdana/Frosty'
        InstallDate = (Get-Date -Format 'yyyyMMdd')
    }
    foreach ($entry in $registryValues.GetEnumerator()) {
        New-ItemProperty -Path $uninstallKey -Name $entry.Key -Value ([string]$entry.Value) -PropertyType String -Force | Out-Null
    }
    New-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourceSnapshot) | Out-Null
    if (Test-Path -LiteralPath $sourceSnapshot) { Remove-Item -LiteralPath $sourceSnapshot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $sourceSnapshot | Out-Null
    & robocopy $src $sourceSnapshot /E /NFL /NDL /NJH /NJS /NP /XD 'node_modules' '.git' 'dist' 'native\build'
    if ($LASTEXITCODE -ge 8) { throw "Could not preserve the source snapshot (robocopy exit code $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0

    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shortcutPaths = @((Join-Path $startMenu 'Frosty.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'))
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = (Join-Path $installDir 'Frosty.exe')
        $shortcut.WorkingDirectory = $installDir
        $shortcut.Description = 'Frosty native Windows video editor'
        $shortcut.Save()
    }

    Write-Step 'Frosty installed successfully'
    Write-Host "Installed app: $(Join-Path $installDir 'Frosty.exe')" -ForegroundColor Green
    Write-Host "Source snapshot: $sourceSnapshot" -ForegroundColor Green
    Start-Process (Join-Path $installDir 'Frosty.exe')
} catch {
    Write-Host "`n[Frosty] INSTALLATION FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No success message was issued. Review the error above; prerequisites installed so far can be reused on the next run.' -ForegroundColor Yellow
    throw
} finally {
    Remove-Item -LiteralPath $sourceZip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
