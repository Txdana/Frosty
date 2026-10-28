# Frosty one-command Windows installer.
# Run from PowerShell: irm https://raw.githubusercontent.com/Txdana/Frosty/master/installer.ps1 | iex
# Builds from this repository's source; no unverified prebuilt application executable is downloaded.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$Message) { Write-Host ''; Write-Host ("[Frosty] " + $Message) -ForegroundColor Cyan }
function Note([string]$Message) { Write-Host ("[Frosty] " + $Message) -ForegroundColor Yellow }
function Has([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $parts = @($env:Path,[Environment]::GetEnvironmentVariable('Path','Machine'),
    [Environment]::GetEnvironmentVariable('Path','User'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $env:Path = ($parts | Select-Object -Unique) -join ';'
}
function WingetPath {
  $w = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $w) { $w = Get-Command winget -ErrorAction SilentlyContinue }
  if ($w) { return $w.Source }
  return $null
}
function Install-Package([string]$Id, [string[]]$Extra = @()) {
  $w = WingetPath
  if (-not $w) { throw 'WinGet is missing. Install or update App Installer from Microsoft Store, then rerun.' }
  Step "Installing prerequisite $Id"
  $a = @('install','--id',$Id,'--exact','--source','winget','--accept-package-agreements','--accept-source-agreements') + $Extra
  & $w @a
  if ($LASTEXITCODE -ne 0) { throw "WinGet failed for $Id (exit code $LASTEXITCODE). Resolve the error and rerun." }
  Refresh-Path
}
function Node-Ready {
  if (-not (Has node) -or -not (Has npm)) { return $false }
  try { return ([int]((node -p "process.versions.node.split('.')[0]").Trim()) -ge 20) } catch { return $false }
}
function Dotnet8-Ready {
  if (-not (Has dotnet)) { return $false }
  try { return (((& dotnet --list-sdks 2>$null) -join [Environment]::NewLine) -match '(^|\r?\n)8\.') } catch { return $false }
}
function Python-Ready {
  foreach ($n in @('py','python3','python')) {
    if (Has $n) {
      try {
        if ($n -eq 'py') { & py -3 --version *> $null } else { & $n --version *> $null }
        if ($LASTEXITCODE -eq 0) { return $true }
      } catch {}
    }
  }
  return $false
}
function Ensure-VsCpp {
  $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
  $valid = $null
  if (Test-Path $vswhere) {
    $x = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($x) { $valid = ($x | Select-Object -First 1).Trim() }
  }
  if ($valid) { Write-Host ("Visual Studio C++ toolchain found: " + $valid) -ForegroundColor Green; return }
  $existing = $null
  if (Test-Path $vswhere) {
    $x = & $vswhere -latest -products '*' -property installationPath 2>$null
    if ($x) { $existing = ($x | Select-Object -First 1).Trim() }
  }
  if ($existing) {
    $setup = Join-Path $pf86 'Microsoft Visual Studio\Installer\setup.exe'
    if (-not (Test-Path $setup)) { throw 'Visual Studio is present but setup.exe is missing; repair Visual Studio Build Tools and rerun.' }
    Step 'Adding the Desktop development with C++ workload and Windows SDK'
    & $setup modify --installPath $existing --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait --norestart
    if ($LASTEXITCODE -ne 0) { throw 'Could not add the Visual Studio C++ workload. Allow any UAC prompt, then rerun.' }
  } else {
    Install-Package 'Microsoft.VisualStudio.2022.BuildTools' @('--override','--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
  }
  Refresh-Path
  if (-not (Test-Path $vswhere)) { throw 'Visual Studio Build Tools was not detected after installation.' }
  $valid = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if (-not $valid) { throw 'MSVC C++ tools are missing. Open Visual Studio Installer and install Desktop development with C++.' }
}
function Ensure-Boost {
  $root = Join-Path $env:LOCALAPPDATA 'Frosty\toolchain\vcpkg'
  if (-not [string]::IsNullOrWhiteSpace($env:VCPKG_ROOT) -and (Test-Path (Join-Path $env:VCPKG_ROOT 'vcpkg.exe'))) { $root = $env:VCPKG_ROOT }
  $header = Join-Path $root 'installed\x64-windows\include\boost\property_tree\ptree.hpp'
  if (-not (Test-Path $header)) {
    Step 'Installing Boost.PropertyTree through Microsoft vcpkg'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $root) | Out-Null
    if (-not (Test-Path (Join-Path $root 'bootstrap-vcpkg.bat'))) {
      $zip = Join-Path $env:TEMP ('vcpkg-' + [guid]::NewGuid().ToString('N') + '.zip')
      $tmp = Join-Path $env:TEMP ('vcpkg-src-' + [guid]::NewGuid().ToString('N'))
      try {
        Invoke-WebRequest -Uri 'https://github.com/microsoft/vcpkg/archive/refs/heads/master.zip' -OutFile $zip -UseBasicParsing
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        $source = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
        if (-not $source -or -not (Test-Path (Join-Path $source.FullName 'bootstrap-vcpkg.bat'))) { throw 'The official vcpkg archive had an unexpected layout.' }
        if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        Move-Item -LiteralPath $source.FullName -Destination $root
      } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    & (Join-Path $root 'bootstrap-vcpkg.bat') -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw 'vcpkg bootstrap failed.' }
    $env:VCPKG_ROOT = $root
    $env:VCPKG_DISABLE_METRICS = '1'
    & (Join-Path $root 'vcpkg.exe') install 'boost-property-tree:x64-windows' --disable-metrics
    if ($LASTEXITCODE -ne 0) { throw 'vcpkg could not install Boost.PropertyTree.' }
  }
  if (-not (Test-Path $header)) { throw 'Boost.PropertyTree headers were not installed.' }
  $env:VCPKG_ROOT = $root
  $env:BOOST_ROOT = Join-Path $root 'installed\x64-windows\include'
}
function Ensure-FFmpeg([string]$Helper) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Helper -CheckOnly
  if ($LASTEXITCODE -eq 0) { return }
  if (-not (WingetPath)) { throw 'FFmpeg is missing and WinGet is unavailable. Install App Installer or FFmpeg manually.' }
  Note 'Frosty does not bundle FFmpeg. The suggested Gyan.FFmpeg WinGet package is declared GPL-3.0 by its manifest.'
  $answer = Read-Host 'Install Gyan.FFmpeg now? [Y/n]'
  if ($answer -match '^(n|no)$') { throw 'FFmpeg is required for the installation tests and media features. Install a compatible build and rerun.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Helper -InstallIfMissing
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg installation failed.' }
  Refresh-Path
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Helper -CheckOnly
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg did not pass its verification check.' }
}

$repo = $env:FROSTY_REPO
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = 'Txdana/Frosty' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid FROSTY_REPO '$repo'. Use owner/repository." }
$branch = $env:FROSTY_BRANCH
if ([string]::IsNullOrWhiteSpace($branch)) { $branch = 'master' }
if ($branch -notmatch '^[A-Za-z0-9_.-]+$') { throw 'FROSTY_BRANCH must be a simple branch name.' }
$sourceUrl = $env:FROSTY_SOURCE_URL
if ([string]::IsNullOrWhiteSpace($sourceUrl)) { $sourceUrl = "https://github.com/$repo/archive/refs/heads/$branch.zip" }
$stage = Join-Path $env:TEMP ('frosty-source-' + [guid]::NewGuid().ToString('N'))
$sourceZip = Join-Path $env:TEMP ('frosty-' + [guid]::NewGuid().ToString('N') + '.zip')
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$sourceSnapshot = Join-Path $env:LOCALAPPDATA 'Frosty\source-build\project'
try {
  Step "Downloading Frosty source from $repo ($branch)"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Invoke-WebRequest -Uri $sourceUrl -OutFile $sourceZip -UseBasicParsing
  if (-not (Test-Path $sourceZip) -or (Get-Item $sourceZip).Length -lt 1024) { throw 'The source archive is empty or unexpectedly small.' }
  Expand-Archive -LiteralPath $sourceZip -DestinationPath $stage -Force
  $project = Get-ChildItem -LiteralPath $stage -Filter 'Frosty.Desktop.csproj' -Recurse -File | Select-Object -First 1
  if (-not $project) { throw 'The source archive lacks windows/Frosty.Desktop/Frosty.Desktop.csproj; check repository and branch.' }
  $src = (Resolve-Path (Join-Path $project.Directory.FullName '..\..')).Path
  $pkgFile = Join-Path $src 'package.json'
  if (-not (Test-Path $pkgFile) -or (Get-Content $pkgFile -Raw | ConvertFrom-Json).name -ne 'frosty') { throw 'The downloaded source is not a valid Frosty project.' }
  foreach ($required in @('native\CMakeLists.txt','scripts\build-native.ps1','scripts\install-ffmpeg.ps1','LICENSE')) {
    if (-not (Test-Path (Join-Path $src $required))) { throw "Required project file is missing: $required" }
  }
  Step 'Installing missing build prerequisites (a fresh machine may download several GB)'
  if (-not (Node-Ready)) { Install-Package 'OpenJS.NodeJS.LTS' }
  if (-not (Node-Ready)) { throw 'Node.js 20+ was not available after installation. Open a new terminal and rerun.' }
  if (-not (Has cmake)) { Install-Package 'Kitware.CMake' }
  if (-not (Has cmake)) { throw 'CMake was not available after installation.' }
  $cmakeText = (& cmake --version | Select-Object -First 1) -replace '^cmake version ', ''
  try { $cmakeVersion = [version]$cmakeText } catch { throw "Could not parse installed CMake version: $cmakeText" }
  if ($cmakeVersion -lt [version]'3.20') { Install-Package 'Kitware.CMake' }
  if (-not (Dotnet8-Ready)) { Install-Package 'Microsoft.DotNet.SDK.8' }
  if (-not (Dotnet8-Ready)) { throw '.NET 8 SDK was not detected after installation.' }
  if (-not (Python-Ready)) { Install-Package 'Python.Python.3.13' }
  if (-not (Python-Ready)) { throw 'Python 3 was not detected after installation.' }
  Ensure-VsCpp
  Ensure-Boost
  Ensure-FFmpeg (Join-Path $src 'scripts\install-ffmpeg.ps1')
  Step 'Running Frosty regression tests'
  Push-Location $src
  try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Frosty tests failed. The app was not installed.' }
    Step 'Building native C++ core and self-contained WPF app'
    & (Join-Path $src 'scripts\build-native.ps1') -Configuration Release -Runtime 'win-x64' -OutputDirectory 'dist/native-windows'
    if ($LASTEXITCODE -ne 0) { throw 'Native C++/WPF build failed. The app was not installed.' }
  } finally { Pop-Location }
  $published = Join-Path $src 'dist\native-windows'
  $exe = Join-Path $published 'Frosty.exe'
  if (-not (Test-Path $exe)) { throw 'The build did not produce dist/native-windows/Frosty.exe.' }
  foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
    if (Test-Path (Join-Path $published $name)) { throw "Refusing to install a bundled $name; FFmpeg must remain separately installed." }
  }
  Step "Installing Frosty to $installDir"
  Get-Process -Name Frosty -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item -Path (Join-Path $published '*') -Destination $installDir -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourceSnapshot) | Out-Null
  if (Test-Path $sourceSnapshot) { Remove-Item -LiteralPath $sourceSnapshot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $sourceSnapshot | Out-Null
  & robocopy $src $sourceSnapshot /E /NFL /NDL /NJH /NJS /NP /XD 'node_modules' '.git' 'dist' 'native\build' 'native\build-p2'
  if ($LASTEXITCODE -ge 8) { throw "Could not preserve the source snapshot (robocopy exit code $LASTEXITCODE)." }
  $global:LASTEXITCODE = 0
  $shell = New-Object -ComObject WScript.Shell
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  foreach ($link in @((Join-Path $startMenu 'Frosty.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'))) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $installDir 'Frosty.exe'
    $shortcut.WorkingDirectory = $installDir
    $shortcut.Description = 'Frosty Windows video editor'
    $shortcut.Save()
  }
  Step 'Frosty was installed successfully'
  Write-Host ("Application: " + (Join-Path $installDir 'Frosty.exe')) -ForegroundColor Green
  Write-Host ("Source snapshot: " + $sourceSnapshot) -ForegroundColor Green
  Start-Process (Join-Path $installDir 'Frosty.exe')
} catch {
  Write-Host ("[Frosty] INSTALLATION FAILED: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Prerequisites already installed can be reused. Review the error above, resolve it, then rerun the same command.' -ForegroundColor Yellow
  throw
} finally {
  Remove-Item -LiteralPath $sourceZip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
