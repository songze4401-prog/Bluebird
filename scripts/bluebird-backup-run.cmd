@echo off
setlocal
set "OUT=%~1"
if "%OUT%"=="" set "OUT=D:\bluebird-backups"
"D:\dev\nodejs\node.exe" "C:\Users\Administrator\WorkBuddy\2026-10-09-20-25-04\bluebird-repo\scripts\bluebird-backup.js" --data-dir "C:\Users\Administrator\Documents\trae_projects\Bluebird\server\data" --out-dir "%OUT%" --keep 7
exit /b %ERRORLEVEL%
