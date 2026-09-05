@echo off
rem Elevated launch. Only admin can load the ring0 driver that exposes CPU
rem package temperature, core clocks and fan speeds.
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~dp0run.bat'"
