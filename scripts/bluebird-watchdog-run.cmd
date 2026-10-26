@echo off
rem Watchdog wrapper. Same repo-relative path resolution as the backup wrapper.
rem Overrides: BLUEBIRD_NODE (node executable), BLUEBIRD_ALERT_CMD (notifier).
setlocal
set "OUT=%~1"
if "%OUT%"=="" set "OUT=D:\bluebird-backups"

set "NODE=%BLUEBIRD_NODE%"
if "%NODE%"=="" set "NODE=node"

if not defined BLUEBIRD_ALERT_CMD set BLUEBIRD_ALERT_CMD="%NODE%" "%~dp0bluebird-alert-notify.js"

"%NODE%" "%~dp0bluebird-backup-check-alert.js" --out-dir "%OUT%"
exit /b %ERRORLEVEL%
