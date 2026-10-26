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

Write-Host '[1/4] Configure C++ engine (Visual Studio x64)...' -ForegroundColor Cyan
cmake -S native -B native/build -A x64
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed. Confirm a C++20 compiler and Boost headers are installed.' }

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
New-Item -ItemType Directory -Force -Path $destination | Out-Null
dotnet publish windows/Frosty.Desktop/Frosty.Desktop.csproj -c $Configuration -r $Runtime --self-contained false -o $destination
if ($LASTEXITCODE -ne 0) { throw 'WPF publish failed.' }
Copy-Item -Force $dll (Join-Path $destination 'frosty_core.dll')
Write-Host "Native Frosty workspace published to: $destination" -ForegroundColor Green
Write-Warning 'This is the Phase 1 project/timeline workspace, not yet a feature-complete video editor. Native FFmpeg preview/export and remaining phases are not included.'
