@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 只监听本机：给 Cloudflare Tunnel / 本机浏览器用，局域网访问不到
set HOST=127.0.0.1
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
"%NODE%" server.mjs
pause
