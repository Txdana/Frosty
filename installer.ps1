# Frosty source-build installer for Windows x64.
# Usage after publishing this script and source to your own GitHub repo:
#   irm https://raw.githubusercontent.com/OWNER/Frosty/main/installer.ps1 | iex
# Optional: set $env:FROSTY_REPO='OWNER/Frosty' before the irm command.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) { Write-Host "`n[Frosty] $Message" -ForegroundColor Cyan }
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

$repo = $env:FROSTY_REPO
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = 'OWNER/Frosty' }
$sourceUrl = $env:FROSTY_SOURCE_URL
if ([string]::IsNullOrWhiteSpace($sourceUrl)) { $sourceUrl = "https://github.com/$repo/archive/refs/heads/main.zip" }
if ($repo -eq 'OWNER/Frosty' -and [string]::IsNullOrWhiteSpace($env:FROSTY_SOURCE_URL)) {
  throw "Frosty source is not published yet. Set `$env:FROSTY_REPO='yourname/Frosty' before running this command, or set FROSTY_SOURCE_URL to a source ZIP URL. The installer builds from source and never downloads a prebuilt Frosty EXE."
}

$root = Join-Path $env:LOCALAPPDATA 'Frosty\source-build'
$zip = Join-Path $env:TEMP ('frosty-source-' + [guid]::NewGuid().ToString('N') + '.zip')
$stage = Join-Path $env:TEMP ('frosty-src-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Frosty'
New-Item -ItemType Directory -Force -Path $root,$stage | Out-Null

try {
  Write-Step 'Checking build prerequisites'
  if (-not (Test-Command 'node') -or -not (Test-Command 'npm')) {
    if (Test-Command 'winget') {
      Write-Host 'Node.js LTS is required to compile Frosty. Installing it with winget...' -ForegroundColor Yellow
      winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed. Install Node.js LTS from https://nodejs.org/ and rerun this installer.' }
      $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    } else { throw 'Node.js/npm are missing and winget is unavailable. Install Node.js LTS from https://nodejs.org/ then rerun.' }
  }
  $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
  if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required (detected $(node --version)). Install current Node.js LTS and rerun." }

  Write-Step 'Downloading Frosty source (not a prebuilt executable)'
  Invoke-WebRequest -Uri $sourceUrl -OutFile $zip -UseBasicParsing
  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
  $package = Get-ChildItem -LiteralPath $stage -Filter package.json -Recurse | Where-Object { $_.Directory.Name -ne 'node_modules' } | Select-Object -First 1
  if (-not $package) { throw 'Source ZIP does not contain package.json. Check FROSTY_REPO/FROSTY_SOURCE_URL.' }
  $src = $package.Directory.FullName
  $pkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.name -ne 'frosty') { throw "Downloaded project is not Frosty (package name: $($pkg.name))." }

  Write-Step 'Installing build dependencies'
  Push-Location $src
  try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Frosty self-tests failed; refusing to install a failing build.' }
    npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
  } finally { Pop-Location }

  $built = Get-ChildItem -Path (Join-Path $src 'dist') -Filter 'Frosty-Setup-*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $built) { throw 'Build completed but Frosty-Setup-*.exe was not found in dist.' }
  Write-Step 'Installing the locally built Frosty application'
  $setupArgs = '/S "/D=' + $installDir + '"'
  $proc = Start-Process -FilePath $built.FullName -ArgumentList $setupArgs -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "Frosty setup returned exit code $($proc.ExitCode)." }
  Write-Step 'Frosty was built on this PC and installed. Opening Frosty...'
  $exe = Join-Path $installDir 'Frosty.exe'
  if (Test-Path $exe) { Start-Process $exe } else { Write-Host "Installed. Launch Frosty from the Start Menu. (Expected path: $exe)" -ForegroundColor Green }
  Write-Host 'Build output and source remain available in the temporary build folder for troubleshooting.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
