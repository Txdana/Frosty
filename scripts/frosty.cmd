@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Frosty-owned shim marker: %LOCALAPPDATA%\Programs\Frosty\Update-Frosty.ps1
set "UPDATER=%LOCALAPPDATA%\Programs\Frosty\Update-Frosty.ps1"
set "UNINSTALLER=%LOCALAPPDATA%\Programs\Frosty\Uninstall-Frosty.ps1"

if /I "%~1"=="--uninstall" (
  if not exist "%UNINSTALLER%" (
    echo [Frosty] Uninstaller is missing. Reinstall Frosty using the latest installer.
    exit /b 2
  )
  echo [Frosty] Launching the uninstaller and optional testing-tool cleanup...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UNINSTALLER%"
  exit /b !ERRORLEVEL!
)

if /I "%~1"=="--update" (
  if /I "%~2"=="latest" (
    if not exist "%UPDATER%" (
      echo [Frosty] Updater is missing. Reinstall Frosty using the latest installer.
      exit /b 2
    )
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATER%" -Channel latest
    exit /b !ERRORLEVEL!
  )
  echo Usage: frosty --update latest
  exit /b 2
)

echo Usage:
echo   frosty --update latest
echo   frosty --uninstall
exit /b 2
