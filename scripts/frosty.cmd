@echo off
setlocal
set "UPDATER=%LOCALAPPDATA%\Programs\Frosty\Update-Frosty.ps1"
if not exist "%UPDATER%" (
  echo [Frosty] Updater is missing. Reinstall Frosty using the latest installer.
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATER%" %*
exit /b %ERRORLEVEL%
