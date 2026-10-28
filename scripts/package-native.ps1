[CmdletBinding()]
param([string]$Configuration='Release',[string]$Runtime='win-x64')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
Write-Host 'Checking external FFmpeg runtime (not bundled by Frosty)...' -ForegroundColor Cyan
$ffmpegPath = $null
if (-not [string]::IsNullOrWhiteSpace($env:FROSTY_FFMPEG) -and (Test-Path $env:FROSTY_FFMPEG)) {
  $ffmpegPath = (Resolve-Path -LiteralPath $env:FROSTY_FFMPEG).Path
} else {
  $ffmpegCommand = Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue
  if (-not $ffmpegCommand) { $ffmpegCommand = Get-Command 'ffmpeg' -ErrorAction SilentlyContinue }
  if ($ffmpegCommand) { $ffmpegPath = $ffmpegCommand.Source }
}
if ([string]::IsNullOrWhiteSpace($ffmpegPath) -or -not (Test-Path $ffmpegPath)) { throw 'FFmpeg was not found. Install FFmpeg separately and add it to PATH, or set FROSTY_FFMPEG to an executable path. No FFmpeg binary is bundled in the Frosty release.' }
$ffmpegVersionOutput = & $ffmpegPath -hide_banner -version 2>&1
if ($LASTEXITCODE -ne 0) { throw 'The external FFmpeg executable was found but failed its version check.' }
$ffmpegVersion = $ffmpegVersionOutput | Select-Object -First 1
Write-Host "Using separately installed FFmpeg: $ffmpegPath ($ffmpegVersion)" -ForegroundColor Green
Write-Host 'Running JavaScript regression suite before packaging the native app...' -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw 'JavaScript regression tests failed; refusing to create a native release package.' }
& (Join-Path $PSScriptRoot 'build-native.ps1') -Configuration $Configuration -Runtime $Runtime -OutputDirectory 'dist/native-windows'
if ($LASTEXITCODE -ne 0) { throw 'Native build failed; no package was created.' }
$published=Join-Path $root 'dist/native-windows'
if (-not (Test-Path (Join-Path $published 'Frosty.exe'))) { throw 'Native publish did not produce Frosty.exe.' }
foreach ($forbiddenMediaBinary in @('ffmpeg.exe', 'ffprobe.exe')) {
  if (Test-Path (Join-Path $published $forbiddenMediaBinary)) { throw "Refusing to package $forbiddenMediaBinary: FFmpeg/FFprobe must remain separately installed under their own license terms." }
}
$release=Join-Path $root 'dist/releases'
New-Item -ItemType Directory -Force -Path $release | Out-Null
$archive=Join-Path $release ("Frosty-Native-win-x64-{0}.zip" -f (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version)
if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $published '*') -DestinationPath $archive -CompressionLevel Optimal
Write-Host "Native Frosty distribution created: $archive" -ForegroundColor Green
Write-Host 'This is the C++/WPF application. Electron packaging is available only through the explicit electron:dist scripts.' -ForegroundColor Cyan
