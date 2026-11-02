@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 优先用包内自带的 node.exe，删掉它则用系统 PATH 里的 node
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
start "InstaBox Panel" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5174'"
"%NODE%" server.mjs
pause
