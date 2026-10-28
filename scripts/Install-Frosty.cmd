@echo off
setlocal
set "SCRIPT=%~dp0Install-Frosty.ps1"
if not exist "%SCRIPT%" (
  echo [Frosty] Install-Frosty.ps1 was not found beside this launcher.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo [Frosty] Installation did not finish successfully. Review the message above.
  pause
)
exit /b %RESULT%
