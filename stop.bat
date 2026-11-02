@echo off
chcp 65001 >nul
setlocal
echo Stopping InstaBox panel on port 5174 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue; if (-not $p) { Write-Host '  nothing listening on 5174 (already stopped).' } else { $p | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"
echo Done.
ping -n 4 127.0.0.1 >nul
