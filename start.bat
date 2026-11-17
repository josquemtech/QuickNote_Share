@echo off
setlocal
cd /d "%~dp0"

if exist "C:\laragon\bin\nodejs\node-v22\node.exe" (
  set "NODE_EXE=C:\laragon\bin\nodejs\node-v22\node.exe"
) else (
  set "NODE_EXE=node"
)

"%NODE_EXE%" --disable-warning=ExperimentalWarning server.js
if errorlevel 1 pause
