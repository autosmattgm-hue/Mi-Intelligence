@echo off
title MI - GO LIVE
cd /d "%~dp0"
echo =====================================================
echo   MI - Master Intelligence  ::  GO LIVE
echo =====================================================
echo.
echo  This opens a PUBLIC link anyone can open in a browser.
echo  (First run downloads the small tunnel client - a few seconds.)
echo.
node tools\live.js
echo.
pause