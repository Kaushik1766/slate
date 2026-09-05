@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Setting up the environment, this happens once...
  py -3 -m venv .venv
  if errorlevel 1 python -m venv .venv
  if errorlevel 1 goto nopython
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
)

if not exist "vendor\lhm\LibreHardwareMonitorLib.dll" (
  echo Fetching sensor library...
  ".venv\Scripts\python.exe" tools\fetch_vendor.py
)

".venv\Scripts\python.exe" -m server.main
echo.
echo Slate stopped.
pause
exit /b

:nopython
echo Python 3.10 or newer was not found on PATH.
echo Install it from https://python.org and run this again.
pause
