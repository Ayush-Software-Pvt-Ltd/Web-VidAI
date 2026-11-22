@echo off
rem Starts VidAI Server: the app in your browser, the backend on this computer.
rem   start.cmd                 install and build what is missing, then start
rem   start.cmd --port 15000    use another port
rem   start.cmd -h              show every option
rem Stop it with Ctrl+C in this window (running edits are paused first).
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo start.cmd: Node.js is not installed. Install version 22.13 or newer from https://nodejs.org and run this again. 1>&2
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo start.cmd: This Node.js is too old. VidAI needs version 22.13 or newer from https://nodejs.org. 1>&2
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist dist\index.html (
  echo Building the user interface...
  call npm run build
  if errorlevel 1 exit /b 1
)

node server\src\main.js %*
exit /b %errorlevel%
