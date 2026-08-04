@echo off
setlocal
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3032"
if not exist "%~dp0runtime" mkdir "%~dp0runtime"
echo Starting pure registration service at http://127.0.0.1:%PORT%
node "%~dp0server.js"
