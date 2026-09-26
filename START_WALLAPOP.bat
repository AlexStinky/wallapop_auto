@echo off
title Wallapop Bot Launcher
color 0A

echo ========================================================
echo           WALLAPOP BOT - Launching Services
echo ========================================================
echo.

echo [1/3] Clearing ports 3000 and 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo [2/3] Starting Backend (port 3001)...
start "Wallapop Backend" cmd /k "cd /d %~dp0backend && title Wallapop Backend && node dist/index.js"

echo [3/3] Starting Frontend (port 3000)...
start "Wallapop Frontend" cmd /k "cd /d %~dp0frontend && title Wallapop Frontend && npm run dev"

echo.
echo Waiting 5 seconds for services to initialize...
ping -n 6 127.0.0.1 >nul

echo.
echo Opening browser: http://localhost:3000
start http://localhost:3000

echo.
echo ========================================================
echo   Wallapop Bot is RUNNING!
echo   Press any key to STOP all services.
echo ========================================================
pause >nul

echo.
echo Stopping services...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Wallapop Backend*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Wallapop Frontend*" >nul 2>&1
echo Done.
ping -n 3 127.0.0.1 >nul
