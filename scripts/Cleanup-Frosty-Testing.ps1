[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Apply,
    [switch]$IncludeSharedTools,
    [switch]$KeepFrostyBuildCache
)

$ErrorActionPreference = 'Continue'
$knownWingetIds = @(
    'OpenJS.NodeJS.LTS', 'OpenJS.NodeJS', 'OpenJS.NodeJS.20', 'OpenJS.NodeJS.22',
    'Kitware.CMake',
    'Microsoft.DotNet.SDK.8', 'Microsoft.DotNet.SDK.9', 'Microsoft.DotNet.SDK.10',
    'Python.Python.3.11', 'Python.Python.3.12', 'Python.Python.3.13',
    'Microsoft.VisualStudio.2022.BuildTools',
    'Gyan.FFmpeg', 'BtbN.FFmpeg.GPL'
)
$knownChocolateyIds = @('nodejs-lts', 'nodejs', 'cmake', 'dotnet-8.0-sdk', 'dotnet-9.0-sdk', 'dotnet-10.0-sdk', 'python311', 'python312', 'python313', 'visualstudio2022buildtools', 'ffmpeg')
$knownScoopIds = @('nodejs-lts', 'nodejs', 'cmake', 'dotnet-sdk', 'python', 'ffmpeg')
$actions = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[string]]::new()

function Add-Action([string]$Kind, [string]$Name, [string]$Command, [string[]]$Arguments) {
    $actions.Add([pscustomobject]@{ Kind=$Kind; Name=$Name; Command=$Command; Arguments=$Arguments })
}
function Find-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

$winget = Find-CommandPath 'winget.exe'
if (-not $winget) { $winget = Find-CommandPath 'winget' }
if ($winget) {
    foreach ($id in $knownWingetIds) {
        $listing = (& $winget list --id $id --exact --disable-interactivity 2>&1 | Out-String)
        if ($LASTEXITCODE -eq 0 -and $listing -match [regex]::Escape($id) -and $listing -notmatch '(?i)No installed package found|No installed package') {
            Add-Action 'WinGet' $id $winget @('uninstall','--id',$id,'--exact','--silent','--disable-interactivity','--accept-source-agreements')
        }
    }
} else {
    Write-Warning 'WinGet not found; WinGet-installed tools cannot be detected or removed.'
}

$choco = Find-CommandPath 'choco.exe'
if (-not $choco) { $choco = Find-CommandPath 'choco' }
if ($choco) {
    $installed = (& $choco list --limit-output 2>$null | Out-String)
    foreach ($id in $knownChocolateyIds) {
        if ($installed -match "(?im)^$([regex]::Escape($id))\|") {
            Add-Action 'Chocolatey' $id $choco @('uninstall',$id,'-y','--no-progress')
        }
    }
}

$scoop = Find-CommandPath 'scoop.ps1'
if (-not $scoop) { $scoop = Find-CommandPath 'scoop' }
if ($scoop) {
    $installed = (& $scoop list 2>$null | Out-String)
    foreach ($id in $knownScoopIds) {
        if ($installed -match "(?im)^\s*$([regex]::Escape($id))\s") {
            Add-Action 'Scoop' $id $scoop @('uninstall',$id)
        }
    }
}

$managedRoot = Join-Path $env:LOCALAPPDATA 'Frosty'
$ownedDirs = @(
    (Join-Path $managedRoot 'toolchain'),
    (Join-Path $managedRoot 'source-build'),
    (Join-Path $managedRoot 'source-build.zip'),
    (Join-Path $env:TEMP 'frosty-source-build'),
    (Join-Path $env:TEMP 'frosty-update')
)
if (-not $KeepFrostyBuildCache) {
    foreach ($path in $ownedDirs) {
        if (Test-Path -LiteralPath $path) {
            Add-Action 'Frosty-owned files' $path 'REMOVE_PATH' @($path)
        }
    }
}

Write-Host ''
Write-Host 'Frosty testing-tool cleanup plan' -ForegroundColor Cyan
if ($actions.Count -eq 0) {
    Write-Host 'No matching packages or known Frosty build leftovers were found.' -ForegroundColor Green
    exit 0
}
for ($i = 0; $i -lt $actions.Count; $i++) {
    $a = $actions[$i]
    Write-Host ('[{0}] {1}: {2}' -f ($i + 1), $a.Kind, $a.Name) -ForegroundColor Yellow
}
if (-not $Apply) {
    Write-Host ''
    Write-Host 'Dry run only. Nothing was removed. Re-run with -Apply to execute this plan.' -ForegroundColor Cyan
    exit 0
}
if (-not $IncludeSharedTools) {
    Write-Warning 'Shared developer tools were detected but will not be uninstalled without -IncludeSharedTools.'
    $actions = [System.Collections.Generic.List[object]]::new(@($actions | Where-Object { $_.Kind -eq 'Frosty-owned files' }))
}
if ($actions.Count -eq 0) {
    Write-Host 'Nothing eligible for removal. Add -IncludeSharedTools only if you intentionally want to remove the listed developer tools.' -ForegroundColor Yellow
    exit 0
}
if (-not $PSCmdlet.ShouldProcess('Detected Frosty testing tools and owned build leftovers', 'Uninstall/remove')) { exit 0 }

foreach ($a in $actions) {
    try {
        if ($a.Kind -eq 'Frosty-owned files') {
            $target = [System.IO.Path]::GetFullPath($a.Name)
            $safeRoots = @(
                [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Frosty')).TrimEnd('\') + '\',
                [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
            )
            if (-not ($safeRoots | Where-Object { $target.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) })) {
                $failures.Add("Refused unsafe path: $target")
                continue
            }
            Write-Host "Removing Frosty-owned files: $target"
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
            continue
        }
        Write-Host "Uninstalling $($a.Kind) package $($a.Name)..." -ForegroundColor Yellow
        & $a.Command @($a.Arguments) 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { $failures.Add("$($a.Kind) $($a.Name) returned exit code $LASTEXITCODE") }
    } catch {
        $failures.Add("$($a.Kind) $($a.Name): $($_.Exception.Message)")
    }
}
if ($failures.Count) {
    Write-Warning 'Some cleanup operations failed:'
    $failures | ForEach-Object { Write-Warning " - $_" }
    exit 1
}
Write-Host 'Cleanup finished.' -ForegroundColor Green
