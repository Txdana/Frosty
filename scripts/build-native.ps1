[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64',
    [string]$OutputDirectory = 'dist/native-windows'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

foreach ($tool in @('cmake', 'dotnet')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Required tool '$tool' was not found on PATH. Install CMake and the .NET 8 SDK, then retry."
    }
}

$boostRoots = [System.Collections.Generic.List[string]]::new()
if (-not [string]::IsNullOrWhiteSpace($env:BOOST_ROOT)) { $boostRoots.Add($env:BOOST_ROOT) }
if (-not [string]::IsNullOrWhiteSpace($env:VCPKG_ROOT)) { $boostRoots.Add((Join-Path $env:VCPKG_ROOT 'installed\x64-windows\include')) }
$boostRoots.Add('C:\local')
$boostRoots.Add('C:\Program Files\Boost')
$boostRoots.Add((Join-Path $env:USERPROFILE 'vcpkg\installed\x64-windows\include'))
if (Test-Path 'C:\local') {
    foreach ($candidate in (Get-ChildItem 'C:\local' -Directory -Filter 'boost_*' -ErrorAction SilentlyContinue)) { $boostRoots.Add($candidate.FullName) }
}
$boostInclude = $null
foreach ($candidate in $boostRoots) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'boost\property_tree\ptree.hpp'))) { $boostInclude = (Resolve-Path $candidate).Path; break }
}
if (-not $boostInclude) { throw 'Boost.PropertyTree headers were not found. Install Boost or set BOOST_ROOT to the directory containing boost\property_tree\ptree.hpp. For vcpkg use its installed\x64-windows\include directory.' }

Write-Host '[1/4] Configure C++ engine (Visual Studio 2022 x64, static MSVC runtime)...' -ForegroundColor Cyan
cmake -S native -B native/build -G 'Visual Studio 17 2022' -A x64 "-DBoost_INCLUDE_DIR=$boostInclude" -DBoost_NO_BOOST_CMAKE=ON
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed. Confirm Visual Studio 2022 C++ tools and Boost headers are installed.' }

Write-Host "[2/4] Build native engine ($Configuration)..." -ForegroundColor Cyan
cmake --build native/build --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw 'Native engine build failed.' }

Write-Host '[3/4] Run native regression tests...' -ForegroundColor Cyan
ctest --test-dir native/build -C $Configuration --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Native regression tests failed.' }

$dll = Join-Path $root "native/build/$Configuration/frosty_core.dll"
if (-not (Test-Path $dll)) {
    $dll = Join-Path $root 'native/build/frosty_core.dll'
}
if (-not (Test-Path $dll)) { throw 'CMake succeeded but frosty_core.dll was not found in the expected output paths.' }

Write-Host '[4/4] Publish WPF workspace...' -ForegroundColor Cyan
$destination = Join-Path $root $OutputDirectory
# Remove stale outputs from older builds so old bundled FFmpeg binaries cannot
# accidentally survive in a release directory after this external-runtime change.
if (Test-Path $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
dotnet publish windows/Frosty.Desktop/Frosty.Desktop.csproj -c $Configuration -r $Runtime --self-contained true -p:PublishSingleFile=false -o $destination
if ($LASTEXITCODE -ne 0) { throw 'WPF publish failed.' }
foreach ($noticeFile in @('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'RUNTIME_REQUIREMENTS.md')) {
    $noticeSource = Join-Path $root $noticeFile
    if (-not (Test-Path $noticeSource)) { throw "Required licensing file '$noticeFile' is missing." }
    Copy-Item -Force $noticeSource (Join-Path $destination $noticeFile)
}
Copy-Item -Force $dll (Join-Path $destination 'frosty_core.dll')
# These install helpers are shipped as scripts, not as bundled FFmpeg binaries.
Copy-Item -Force (Join-Path $PSScriptRoot 'install-ffmpeg.ps1') (Join-Path $destination 'install-ffmpeg.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'Install-Frosty.ps1') (Join-Path $destination 'Install-Frosty.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'Install-Frosty.cmd') (Join-Path $destination 'Install-Frosty.cmd')
Copy-Item -Force (Join-Path $PSScriptRoot 'Uninstall-Frosty.ps1') (Join-Path $destination 'Uninstall-Frosty.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'Uninstall-Frosty.cmd') (Join-Path $destination 'Uninstall-Frosty.cmd')
Copy-Item -Force (Join-Path $PSScriptRoot 'Update-Frosty.ps1') (Join-Path $destination 'Update-Frosty.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'frosty.cmd') (Join-Path $destination 'frosty.cmd')
$frostyVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Set-Content -LiteralPath (Join-Path $destination 'FROSTY_VERSION.txt') -Value $frostyVersion -Encoding ascii
Write-Host '[Runtime] Checking external FFmpeg runtime (not bundled or relicensed by Frosty)...' -ForegroundColor Cyan
$ffmpegPath = $null
if (-not [string]::IsNullOrWhiteSpace($env:FROSTY_FFMPEG) -and (Test-Path $env:FROSTY_FFMPEG)) {
    $ffmpegPath = (Resolve-Path -LiteralPath $env:FROSTY_FFMPEG).Path
} else {
    $ffmpegCommand = Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue
    if (-not $ffmpegCommand) { $ffmpegCommand = Get-Command 'ffmpeg' -ErrorAction SilentlyContinue }
    if ($ffmpegCommand) { $ffmpegPath = $ffmpegCommand.Source }
}
if ([string]::IsNullOrWhiteSpace($ffmpegPath) -or -not (Test-Path $ffmpegPath)) {
    throw 'FFmpeg is required but was not found. Install FFmpeg separately and add its bin directory to PATH, or set FROSTY_FFMPEG to a full executable path as a persistent user environment variable. Frosty does not bundle FFmpeg.'
}
$ffmpegVersionOutput = & $ffmpegPath -hide_banner -version 2>&1
if ($LASTEXITCODE -ne 0) { throw 'The external FFmpeg executable was found but failed its version check.' }
$ffmpegVersion = $ffmpegVersionOutput | Select-Object -First 1
Write-Host "External FFmpeg found: $ffmpegPath ($ffmpegVersion)" -ForegroundColor Green
$ffprobePath = $null
if (-not [string]::IsNullOrWhiteSpace($env:FROSTY_FFPROBE) -and (Test-Path $env:FROSTY_FFPROBE)) {
    $ffprobePath = (Resolve-Path -LiteralPath $env:FROSTY_FFPROBE).Path
} else {
    $ffprobeCommand = Get-Command 'ffprobe.exe' -ErrorAction SilentlyContinue
    if (-not $ffprobeCommand) { $ffprobeCommand = Get-Command 'ffprobe' -ErrorAction SilentlyContinue }
    if ($ffprobeCommand) { $ffprobePath = $ffprobeCommand.Source }
}
if ($ffprobePath) { Write-Host "External FFprobe found: $ffprobePath" -ForegroundColor Green } else { Write-Host 'FFprobe not found; Frosty will use its FFmpeg diagnostic fallback where supported.' -ForegroundColor Yellow }
Write-Host "Native Frosty workspace published to: $destination" -ForegroundColor Green
Write-Host 'Self-contained native WPF app published without FFmpeg/FFprobe binaries. Runtime media processing resolves external tools from PATH or the FROSTY_FFMPEG/FROSTY_FFPROBE environment variables.' -ForegroundColor Green
