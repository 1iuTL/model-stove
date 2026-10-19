@echo off
setlocal
REM model-stove launcher.
REM
REM Two notes:
REM 1) Build the absolute path from %CD% instead of "." -- this directory name
REM    contains spaces, so an unquoted path gets truncated, and a relative path
REM    also breaks when the working directory is not respected.
REM 2) --no-sandbox: on this machine Chromium own sandbox init fails and
REM    electron exits within a few hundred ms (code 0x80000003) with no message.
REM    The flag is required to start. See logs\launcher.log.
cd /d "%~dp0"
set ELECTRON="%CD%\node_modules\electron\dist\electron.exe"
if not exist %ELECTRON% (
  echo.
  echo [ERROR] electron.exe not found in %CD%\node_modules\electron\dist\
  echo   fix: run  npm install  inside %CD%
  echo.
  pause
  exit /b 1
)
if not exist "%CD%\src\main.js" (
  echo [ERROR] missing source: %CD%\src\main.js
  pause
  exit /b 1
)
%ELECTRON% --no-sandbox "%CD%"
if errorlevel 1 (
  echo.
  echo [model-stove exited with code %errorlevel%]
  pause
)