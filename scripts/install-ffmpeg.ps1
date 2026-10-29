[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$InstallIfMissing
)

# Frosty never bundles FFmpeg. This helper can ask WinGet to install the
# independently licensed Gyan.FFmpeg package after the user has consented.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Refresh-SearchPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    $parts = @($env:Path, $machinePath, $userPath, $wingetLinks) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $env:Path = ($parts -join ';')
}

function Find-Ffmpeg {
    if (-not [string]::IsNullOrWhiteSpace($env:FROSTY_FFMPEG) -and (Test-Path -LiteralPath $env:FROSTY_FFMPEG -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:FROSTY_FFMPEG).Path
    }

    Refresh-SearchPath
    foreach ($name in @('ffmpeg.exe', 'ffmpeg')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
            return $command.Source
        }
    }

    # WinGet's ZIP-based portable packages can reside under its package cache
    # even if the shell has not refreshed PATH yet. Search only Gyan's package.
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $packages) {
        $roots = Get-ChildItem -LiteralPath $packages -Directory -Filter 'Gyan.FFmpeg_*' -ErrorAction SilentlyContinue
        foreach ($packageRoot in $roots) {
            $candidate = Get-ChildItem -LiteralPath $packageRoot.FullName -File -Filter 'ffmpeg.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($candidate) { return $candidate.FullName }
        }
    }
    return $null
}

function Test-FfmpegExecutable([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $null = & $Path -hide_banner -version 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

$existing = Find-Ffmpeg
if ($existing -and (Test-FfmpegExecutable $existing)) {
    Write-Output "FFmpeg is ready: $existing"
    exit 0
}

if ($CheckOnly) {
    Write-Error 'FFmpeg was not found or could not be executed.' -ErrorAction Continue
    exit 1
}
if (-not $InstallIfMissing) {
    Write-Error 'Use -CheckOnly to inspect the prerequisite or -InstallIfMissing after user consent.' -ErrorAction Continue
    exit 2
}

$winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
if (-not $winget) { $winget = Get-Command 'winget' -ErrorAction SilentlyContinue }
if (-not $winget -or -not $winget.Source) {
    Write-Error 'WinGet is unavailable. Install App Installer from the Microsoft Store or install FFmpeg manually from https://ffmpeg.org/download.html.' -ErrorAction Continue
    exit 10
}

Write-Output 'Installing FFmpeg separately through WinGet (package: Gyan.FFmpeg; license declared by WinGet: GPL-3.0)...'
$arguments = @(
    'install', '--id', 'Gyan.FFmpeg', '--exact', '--source', 'winget',
    '--silent', '--accept-package-agreements', '--accept-source-agreements'
)
& $winget.Source @arguments
if ($LASTEXITCODE -ne 0) {
    Write-Error "WinGet failed to install Gyan.FFmpeg (exit code $LASTEXITCODE)." -ErrorAction Continue
    exit $LASTEXITCODE
}

# Refresh our process environment after WinGet updates the user's PATH.
Refresh-SearchPath
$installed = $null
for ($attempt = 0; $attempt -lt 5 -and -not $installed; $attempt++) {
    $candidate = Find-Ffmpeg
    if ($candidate -and (Test-FfmpegExecutable $candidate)) { $installed = $candidate; break }
    Start-Sleep -Milliseconds 500
}
if (-not $installed) {
    Write-Error 'WinGet completed, but ffmpeg.exe could not be located or executed. Open a new session or install FFmpeg manually.' -ErrorAction Continue
    exit 11
}
Write-Output "FFmpeg installed and verified: $installed"
exit 0
