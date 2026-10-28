# FFmpeg setup helper for Frosty. FFmpeg remains a separate third-party executable.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$InstallIfMissing)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Refresh-Path {
  $env:Path = (@($env:Path,[Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User'),(Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')) | Where-Object { $_ } | Select-Object -Unique) -join ';'
}
function Find-Ffmpeg {
  if ($env:FROSTY_FFMPEG -and (Test-Path -LiteralPath $env:FROSTY_FFMPEG -PathType Leaf)) { return (Resolve-Path $env:FROSTY_FFMPEG).Path }
  Refresh-Path
  $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command ffmpeg -ErrorAction SilentlyContinue }
  if ($command -and $command.Source -and (Test-Path $command.Source -PathType Leaf)) { return $command.Source }
  $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $packages) {
    foreach ($root in (Get-ChildItem $packages -Directory -Filter 'Gyan.FFmpeg_*' -ErrorAction SilentlyContinue)) {
      $candidate = Get-ChildItem $root.FullName -File -Filter 'ffmpeg.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($candidate) { return $candidate.FullName }
    }
  }
  return $null
}
function Test-Ffmpeg([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try { $null = & $Path -hide_banner -version 2>&1; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
$found = Find-Ffmpeg
if ($found -and (Test-Ffmpeg $found)) { Write-Output "FFmpeg is ready: $found"; exit 0 }
if ($CheckOnly) { Write-Error 'FFmpeg was not found or could not run.'; exit 1 }
if (-not $InstallIfMissing) { Write-Error 'Use -CheckOnly or -InstallIfMissing after displaying package license and obtaining consent.'; exit 2 }
$w = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $w) { $w = Get-Command winget -ErrorAction SilentlyContinue }
if (-not $w) { Write-Error 'WinGet is unavailable. Install App Installer or install FFmpeg manually.'; exit 10 }
Write-Output 'Installing separate third-party package Gyan.FFmpeg (WinGet manifest license: GPL-3.0)...'
& $w.Source install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) { Write-Error "WinGet failed to install Gyan.FFmpeg (exit code $LASTEXITCODE)."; exit $LASTEXITCODE }
Refresh-Path
$found = Find-Ffmpeg
if (-not $found -or -not (Test-Ffmpeg $found)) { Write-Error 'FFmpeg was not detected after installation. Open a new terminal or install it manually.'; exit 11 }
Write-Output "FFmpeg installed and verified: $found"
exit 0
