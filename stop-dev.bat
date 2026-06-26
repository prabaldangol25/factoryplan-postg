@echo off
cd /d "%~dp0"
where bash.exe >nul 2>nul
if errorlevel 1 (
  echo Git Bash was not found on PATH. Install Git for Windows or run dev.sh from a Bash shell.
  pause
  exit /b 1
)
bash "%~dp0dev.sh" stop
pause
