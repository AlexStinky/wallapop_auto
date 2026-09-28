@echo off
chcp 65001 >nul
title Wallapop Bot Launcher
color 0A

echo ========================================================
echo           WALLAPOP BOT - Launching Services
echo ========================================================
echo.

cd /d %~dp0

:: Try to quietly ensure firewall rules exist
netsh advfirewall firewall add rule name="Wallapop Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3001" dir=in action=allow protocol=TCP localport=3001 profile=any enable=yes >nul 2>&1

:: Detect local IP address dynamically
set LOCAL_IP=
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -ExpandProperty IPv4Address | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
if "%LOCAL_IP%"=="" (
    for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|WSL' -and $_.IPAddress -notmatch '^127\.|^169\.254\.' } | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
)
if "%LOCAL_IP%"=="" set LOCAL_IP=localhost

echo [1/6] Clearing ports 3000 and 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo.
echo [2/6] Updating code from Git (git pull)...
git checkout -- backend/dist backend/package-lock.json frontend/package-lock.json >nul 2>&1
git pull
if %errorlevel% neq 0 (
    echo - Conflict detected. Resetting tracked files and retrying pull...
    git reset --hard HEAD
    git pull
)

echo.
echo [3/6] Clearing cache (.next, dist)...
if exist "%~dp0frontend\.next" (
    echo - Removing frontend .next cache...
    rd /s /q "%~dp0frontend\.next" >nul 2>&1
)
if exist "%~dp0backend\dist" (
    echo - Removing backend dist cache...
    rd /s /q "%~dp0backend\dist" >nul 2>&1
)

echo.
echo [4/6] Updating Backend dependencies (npm install) and building...
cd /d %~dp0backend
call npm install
call npm run build

echo.
echo [5/6] Updating Frontend dependencies (npm install) and building...
cd /d %~dp0frontend
call npm install
call npm run build

cd /d %~dp0

echo.
echo [6/6] Starting Services...
echo - Starting Backend (port 3001)...
start "Wallapop Backend" cmd /k "cd /d %~dp0backend && title Wallapop Backend && node dist/index.js"

echo - Starting Frontend (port 3000)...
start "Wallapop Frontend" cmd /k "cd /d %~dp0frontend && title Wallapop Frontend && npm start -- -H 0.0.0.0"

echo.
echo Waiting 5 seconds for services to initialize...
ping -n 6 127.0.0.1 >nul

echo.
echo Opening browser: http://localhost:3000
start http://localhost:3000

echo.
echo ========================================================
echo   Wallapop Bot УСПЕШНО ЗАПУЩЕН!
echo.
echo   Компьютер:         http://localhost:3000
echo   Телефон (Wi-Fi):   http://%LOCAL_IP%:3000
echo.
echo   ------------------------------------------------------
echo   ВАЖНО ДЛЯ ВХОДА С ТЕЛЕФОНА:
echo   - Телефон должен быть подключен к этому же Wi-Fi!
echo   - Если страница на телефоне не открывается, один раз
echo     запустите ALLOW_FIREWALL.bat от имени администратора.
echo.
echo   Нажмите любую клавишу для ОСТАНОВКИ всех сервисов.
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
