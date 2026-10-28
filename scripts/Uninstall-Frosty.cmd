@echo off
setlocal
set "SCRIPT=%~dp0Uninstall-Frosty.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%LOCALAPPDATA%\Programs\Frosty\Uninstall-Frosty.ps1"
if not exist "%SCRIPT%" (
  echo [Frosty] Could not find the installed uninstaller.
  echo If Frosty is installed, reinstall or repair it before uninstalling.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
