@echo off
setlocal
set "UPDATER=%LOCALAPPDATA%\Programs\Frosty\Update-Frosty.ps1"
if not exist "%UPDATER%" (
  echo [Frosty] Updater is missing. Reinstall Frosty using the latest installer.
  exit /b 2
)
if /I "%~1"=="--update" (
  if /I "%~2"=="latest" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATER%" -Channel latest
    exit /b %ERRORLEVEL%
  )
  echo Usage: frosty --update latest
  exit /b 2
)
echo Usage: frosty --update latest
exit /b 2
