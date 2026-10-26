@echo off
setlocal
set "OUT=%~1"
if "%OUT%"=="" set "OUT=D:\bluebird-backups"
set "BLUEBIRD_ALERT_CMD=D:\dev\nodejs\node.exe C:\Users\Administrator\WorkBuddy\2026-10-09-20-25-04\bluebird-repo\scripts\bluebird-alert-notify.js"
"D:\dev\nodejs\node.exe" "C:\Users\Administrator\WorkBuddy\2026-10-09-20-25-04\bluebird-repo\scripts\bluebird-backup-check-alert.js" --out-dir "%OUT%"
exit /b %ERRORLEVEL%
