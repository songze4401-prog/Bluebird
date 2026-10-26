@echo off
rem Scheduled-task wrapper. Paths are resolved relative to this script (%ROOT%),
rem so the wrapper keeps working after the repo is moved or re-cloned.
rem Overrides: BLUEBIRD_NODE (node executable), BLUEBIRD_DATA_DIR (data dir).
setlocal
set "ROOT=%~dp0.."
set "OUT=%~1"
if "%OUT%"=="" set "OUT=D:\bluebird-backups"

set "NODE=%BLUEBIRD_NODE%"
if "%NODE%"=="" set "NODE=node"

set "DATA=%BLUEBIRD_DATA_DIR%"
if "%DATA%"=="" set "DATA=%ROOT%\server\data"

"%NODE%" "%~dp0bluebird-backup.js" --data-dir "%DATA%" --out-dir "%OUT%" --keep 7
exit /b %ERRORLEVEL%
