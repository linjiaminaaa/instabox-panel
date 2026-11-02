@echo off
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
if exist "%~dp0node.exe" goto run
where node >nul 2>nul
if not errorlevel 1 goto run
echo First run: downloading Node.js runtime ^(~30 MB^) from npmmirror, please wait...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest 'https://registry.npmmirror.com/-/binary/node/v24.16.0/win-x64/node.exe' -OutFile 'node.exe' -UseBasicParsing -TimeoutSec 900; exit 0 } catch { exit 1 }"
if not exist "%~dp0node.exe" (
  echo Download failed. Install Node.js 18+ from https://nodejs.org, or put node.exe next to this file.
  pause
  exit /b 1
)
set "NODE=%~dp0node.exe"
:run
start "InstaBox Panel" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5174'"
"%NODE%" server.mjs
pause
