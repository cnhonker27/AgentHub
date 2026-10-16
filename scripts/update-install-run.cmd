@echo off
rem ============================================================
rem  AgentHub - sync upstream / install deps / run   (Windows)
rem  Double-click this file, or run it with arguments, e.g.
rem    update-install-run.cmd --proxy=http://192.168.0.54:1234
rem    update-install-run.cmd --no-run
rem    update-install-run.cmd --remote=upstream --branch=main
rem  Merges upstream (default remote=upstream, branch=main) into the CURRENT branch:
rem  local commits are kept, a CONFLICT stops and asks you to resolve it by hand.
rem  Proxy can also be put in update-install-run.proxy.txt (first line).
rem  If upstream is unreachable, the app still launches with the local version;
rem  use --strict-update to abort instead.
rem  All user-facing messages are printed by the Node script
rem  (this file stays ASCII-only on purpose, to avoid codepage issues).
rem ============================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found. Please install Node.js ^(^>=18^) and add it to PATH.
  echo.
  pause
  exit /b 1
)

if not defined AGENTHUB_PROXY (
  if exist "%~dp0update-install-run.proxy.txt" (
    for /f "usebackq tokens=* delims=" %%a in ("%~dp0update-install-run.proxy.txt") do (
      if not defined AGENTHUB_PROXY set "AGENTHUB_PROXY=%%a"
    )
  )
)

node "%~dp0update-install-run.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo [X] exit code: %CODE%
pause
exit /b %CODE%
