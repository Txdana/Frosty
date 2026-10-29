[CmdletBinding()]
param(
    [switch]$Quiet,
    [ValidateRange(0, 2147483647)]
    [int]$WaitForProcessId = 0,
    [switch]$RemoveUntrackedPrerequisites
)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
$installDirFull = [System.IO.Path]::GetFullPath($installDir).TrimEnd('\')
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
if ([System.IO.Path]::GetDirectoryName($installDirFull) -ine $programsRoot -or [System.IO.Path]::GetFileName($installDirFull) -ine 'Frosty') { throw "Refusing to uninstall from an unexpected path: $installDirFull" }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Frosty'
function Remove-ManagedFrostyArtifacts {
    if (-not $Quiet -and -not $RemoveUntrackedPrerequisites) {
        Add-Type -AssemblyName System.Windows.Forms
        $answer = [System.Windows.Forms.MessageBox]::Show('Some tools installed during older Frosty testing may not have an ownership record. Remove common WinGet prerequisites (Node.js, CMake, .NET SDK, Python, Visual Studio Build Tools, FFmpeg) if present? This may affect other applications that use them.', 'Remove untracked developer tools?', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { $script:RemoveUntrackedPrerequisites = $true }
    }
    $shimPath = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\frosty.cmd'
    if (Test-Path -LiteralPath $shimPath) {
        $isFrostyShim = $false
        try { $isFrostyShim = (Get-Content -LiteralPath $shimPath -Raw) -match 'Programs\\Frosty\\Update-Frosty\.ps1' } catch { }
        if ($isFrostyShim) { Remove-Item -LiteralPath $shimPath -Force -ErrorAction SilentlyContinue }
        else { Write-Warning "Leaving unrelated command shim untouched: $shimPath" }
    }
    $managedRoot = Join-Path $env:LOCALAPPDATA 'Frosty'
    $manifestPath = Join-Path $managedRoot 'managed-prerequisites.json'
    $ownedIds = @()
    if (Test-Path -LiteralPath $manifestPath) {
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $ownedIds = @($manifest.wingetPackages | Where-Object { $_ } | Select-Object -Unique)
            foreach ($id in $ownedIds) {
                $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
                if (-not $winget) { $winget = Get-Command 'winget' -ErrorAction SilentlyContinue }
                if ($winget) {
                    Write-Host "[Frosty] Removing installer-managed prerequisite: $id" -ForegroundColor Yellow
                    & $winget.Source uninstall --id $id --exact --silent --disable-interactivity --accept-source-agreements 2>&1 | Out-Host
                    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove $id automatically (exit code $LASTEXITCODE). Uninstall it manually if no longer needed." }
                } else { Write-Warning "WinGet is unavailable; cannot automatically remove managed prerequisite $id." }
            }
        } catch { Write-Warning "Managed prerequisite cleanup had an error: $($_.Exception.Message)" }
        Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
    }
    if ($RemoveUntrackedPrerequisites -or $script:RemoveUntrackedPrerequisites) {
        $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
        if (-not $winget) { $winget = Get-Command 'winget' -ErrorAction SilentlyContinue }
        $knownIds = @('OpenJS.NodeJS.LTS','Kitware.CMake','Microsoft.DotNet.SDK.8','Python.Python.3.13','Microsoft.VisualStudio.2022.BuildTools','Gyan.FFmpeg')
        foreach ($id in $knownIds | Where-Object { $_ -notin $ownedIds }) {
            if (-not $winget) { Write-Warning "WinGet is unavailable; cannot check untracked prerequisite $id."; continue }
            $listed = (& $winget.Source list --id $id --exact --disable-interactivity 2>&1 | Out-String)
            if ($listed -match [regex]::Escape($id) -and $listed -notmatch 'No installed package found') {
                Write-Host "[Frosty] Removing untracked prerequisite at user request: $id" -ForegroundColor Yellow
                & $winget.Source uninstall --id $id --exact --silent --disable-interactivity --accept-source-agreements 2>&1 | Out-Host
                if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove $id automatically (exit code $LASTEXITCODE). Uninstall it manually if no longer needed." }
            }
        }
    }
    Remove-Item -LiteralPath (Join-Path $managedRoot 'toolchain') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $managedRoot 'source-build') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $managedRoot 'source-build.zip') -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $installDirFull)) {
    $staleStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    foreach ($shortcut in @((Join-Path $staleStartMenu 'Frosty.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'))) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ManagedFrostyArtifacts
    Write-Host '[Frosty] App already absent; stale shortcuts, command launcher, Frosty build artifacts and managed prerequisites cleaned where possible.' -ForegroundColor Yellow
    exit 0
}
if (-not $Quiet) {
    Add-Type -AssemblyName System.Windows.Forms
    $message = @"
This will remove Frosty's application files, command launcher, shortcuts, and Windows registration.
Saved .frosty projects, original media, and recovery snapshots will be kept. WinGet packages recorded as newly installed by Frosty (such as Node.js, CMake, .NET SDK, Python, and FFmpeg) can be removed. Pre-existing tools are not removed.
Continue with uninstall?
"@
    $answer = [System.Windows.Forms.MessageBox]::Show($message,'Uninstall Frosty',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { Write-Host '[Frosty] Uninstall cancelled.' -ForegroundColor Yellow; exit 0 }
}
$exePath = [System.IO.Path]::GetFullPath((Join-Path $installDirFull 'Frosty.exe'))
if ($WaitForProcessId -gt 0) {
    try {
        $waiting = Get-Process -Id $WaitForProcessId -ErrorAction Stop
        if ([System.IO.Path]::GetFullPath($waiting.Path) -ieq $exePath) {
            try { $waiting | Wait-Process -Timeout 45 -ErrorAction SilentlyContinue } catch { }
            $waiting = Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue
            if ($waiting) { try { if ([System.IO.Path]::GetFullPath($waiting.Path) -ieq $exePath) { Stop-Process -Id $WaitForProcessId -Force -ErrorAction SilentlyContinue } } catch { } }
        }
    } catch { }
}
Get-Process -Name 'Frosty' -ErrorAction SilentlyContinue | ForEach-Object { try { if ([System.IO.Path]::GetFullPath($_.Path) -ieq $exePath) { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } } catch { } }
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($shortcut in @((Join-Path $startMenu 'Frosty.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Frosty.lnk'))) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-ManagedFrostyArtifacts
Set-Location -LiteralPath $env:TEMP
$escapedInstallDir = $installDirFull.Replace("'", "''")
$deleteCommand = "for (\`$i = 0; \`$i -lt 30; \`$i++) { Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$escapedInstallDir' -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath '$escapedInstallDir')) { break } }"
$encodedDeleteCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($deleteCommand))
$powerShellCommand = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
$powerShell = if ($powerShellCommand) { $powerShellCommand.Source } else { Join-Path $PSHOME 'powershell.exe' }
if (-not (Test-Path -LiteralPath $powerShell)) { throw 'Could not find Windows PowerShell to finish removing the application directory.' }
Start-Process -FilePath $powerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',$encodedDeleteCommand) -WorkingDirectory $env:TEMP -WindowStyle Hidden
Write-Host '[Frosty] Uninstall started. Application files and shortcuts are being removed.' -ForegroundColor Green
Write-Host '[Frosty] Saved projects, source media, and recovery snapshots were preserved. Managed prerequisites and Frosty build artifacts were cleaned up where possible.' -ForegroundColor Cyan
