[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

Write-Host '[Windows E2E 1/4] Parsing every shipped PowerShell installer/build script...' -ForegroundColor Cyan
$powerShellScripts = @(
    'installer.ps1',
    'scripts/Install-Frosty.ps1',
    'scripts/Uninstall-Frosty.ps1',
    'scripts/Cleanup-Frosty-Testing.ps1',
    'scripts/Update-Frosty.ps1',
    'scripts/install-ffmpeg.ps1',
    'scripts/build-native.ps1',
    'scripts/package-native.ps1',
    'test/windows-e2e.ps1',
    'test/windows-lifecycle.ps1'
)
foreach ($relativePath in $powerShellScripts) {
    $scriptPath = Join-Path $root $relativePath
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
        $details = ($parseErrors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join '; '
        throw "PowerShell syntax errors in '$relativePath': $details"
    }
}
Write-Host 'PowerShell installer/build scripts parse cleanly.' -ForegroundColor Green
foreach ($tool in @('cmake','ctest','dotnet','npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required Windows end-to-end tool '$tool' is missing." }
}
Write-Host '[Windows E2E 2/4] Building native C++ core, running CTest and publishing the WPF application...' -ForegroundColor Cyan
& (Join-Path $root 'scripts/build-native.ps1') -Configuration Release -Runtime win-x64 -OutputDirectory 'dist/native-windows-e2e'
if ($LASTEXITCODE -ne 0) { throw 'Native C++ build/WPF publish failed.' }
$published = Join-Path $root 'dist/native-windows-e2e'
$exe = Join-Path $published 'Frosty.exe'
$dll = Join-Path $root 'native/build/Release/frosty_core.dll'
if (-not (Test-Path $exe)) { throw "WPF publish did not produce $exe" }
if (-not (Test-Path $dll)) { $dll = Join-Path $root 'native/build/frosty_core.dll' }
if (-not (Test-Path $dll)) { throw 'Native DLL is missing after CMake build.' }
Copy-Item -Force $dll (Join-Path $published 'frosty_core.dll')
$ffmpegPath = $null
if (-not [string]::IsNullOrWhiteSpace($env:FROSTY_FFMPEG) -and (Test-Path $env:FROSTY_FFMPEG)) {
    $ffmpegPath = (Resolve-Path -LiteralPath $env:FROSTY_FFMPEG).Path
} else {
    $ffmpeg = Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue
    if (-not $ffmpeg) { $ffmpeg = Get-Command 'ffmpeg' -ErrorAction SilentlyContinue }
    if ($ffmpeg) { $ffmpegPath = $ffmpeg.Source }
}
if ([string]::IsNullOrWhiteSpace($ffmpegPath) -or -not (Test-Path $ffmpegPath)) { throw 'External FFmpeg prerequisite missing; Frosty intentionally does not bundle FFmpeg.' }
$ffmpegVersionOutput = & $ffmpegPath -hide_banner -version 2>&1
if ($LASTEXITCODE -ne 0) { throw 'External FFmpeg executable failed its version check.' }
$ffmpegVersion = $ffmpegVersionOutput | Select-Object -First 1
Write-Host "External FFmpeg available for Windows acceptance: $ffmpegPath ($ffmpegVersion)" -ForegroundColor Green
Write-Host '[Windows E2E 3/4] Launching the actual published WPF application in unattended self-test mode...' -ForegroundColor Cyan
$process = Start-Process -FilePath $exe -ArgumentList '--self-test' -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Frosty.exe --self-test exited with code $($process.ExitCode)." }
Write-Host '[Windows E2E 4/4] PASS: native CTest, self-contained WPF publish and WPF startup/shutdown smoke test succeeded.' -ForegroundColor Green
