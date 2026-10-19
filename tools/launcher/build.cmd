@echo off
setlocal
REM usage: build.cmd ^<app-dir^> [output-exe]
REM   default output = ^<app-dir^>\Model Stove.exe
if "%~1"=="" (
  echo usage: build.cmd ^<app-dir^> [output-exe]
  exit /b 1
)
set "APPDIR=%~1"
if "%~2"=="" ( set "OUT=%APPDIR%\Model Stove.exe" ) else ( set "OUT=%~2" )
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" ( echo [ERROR] csc.exe not found; pause; exit /b 1 )
set "SRC=%~dp0ModelStoveLauncher.cs"
set "TMP=%TEMP%\ModelStoveLauncher.%RANDOM%.cs"
powershell -NoProfile -Command "(Get-Content -Raw '%SRC%') -replace '__APP_DIR__', '%APPDIR%' | Set-Content -Encoding UTF8 '%TMP%'"
"%CSC%" /nologo /target:exe /r:System.Windows.Forms.dll "/win32icon:%APPDIR%\model-stove.ico" "/out:%OUT%" "%TMP%"
set "RC=%ERRORLEVEL%"
del "%TMP%" >nul 2>&1
if not "%RC%"=="0" ( echo [ERROR] build failed; pause; exit /b %RC% )
echo built: "%OUT%"