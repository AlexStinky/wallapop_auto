@echo off
title Wallapop Bot Stopper
color 0C

echo ========================================================
echo           WALLAPOP BOT - Stopping Services
echo ========================================================
echo.

echo Stopping Backend on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo Stopping Frontend on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

taskkill /f /fi "WINDOWTITLE eq Wallapop Backend*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Wallapop Frontend*" >nul 2>&1

echo.
echo ========================================================
echo   All Wallapop Bot services stopped successfully!
echo ========================================================
ping -n 3 127.0.0.1 >nul
