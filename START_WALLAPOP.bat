@echo off
chcp 65001 >nul
title Wallapop Bot Launcher
color 0A

echo ========================================================
echo           WALLAPOP BOT - Launching Services
echo ========================================================
echo.

cd /d "%~dp0"

:: Ensure MongoDB service is running if installed
net start MongoDB >nul 2>&1

:: Detect local IP address dynamically using node
set LOCAL_IP=
if exist "%~dp0get-ip.js" (
    for /f "delims=" %%a in ('node "%~dp0get-ip.js"') do set LOCAL_IP=%%a
)
if "%LOCAL_IP%"=="" set LOCAL_IP=localhost

echo Checking service ports...
powershell -NoProfile -Command "if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -match '^(3000|3001)$') { exit 1 }"
if errorlevel 1 (
    echo Port 3000 or 3001 is in use. Close the existing service before launching.
    exit /b 1
)

echo Checking for code updates...
git status --porcelain >nul || goto :failed
set "DIRTY="
for /f "delims=" %%a in ('git status --porcelain') do set "DIRTY=1"
if defined DIRTY (
    echo Local changes detected. Building the current working copy.
) else (
    git pull --ff-only || goto :failed
)

echo Building backend...
cd /d "%~dp0backend" || goto :failed
call npm ci || goto :failed
call npm run db:generate || goto :failed
call npm run build || goto :failed

echo Building frontend...
cd /d "%~dp0frontend" || goto :failed
call npm ci || goto :failed
call npm run build || goto :failed

cd /d "%~dp0"
echo - Starting Backend (port 3001)...
set "HOST=127.0.0.1"
start "Wallapop Backend" /D "%~dp0backend" cmd /d /k "title Wallapop Backend && node dist/index.js"

echo - Starting Frontend (port 3000)...
start "Wallapop Frontend" /D "%~dp0frontend" cmd /d /k "title Wallapop Frontend && npm start"

echo.
echo Waiting for the frontend and backend...
powershell -NoProfile -Command "foreach ($attempt in 1..30) { try { $health = Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 2; if ($health.status -eq 'ok') { exit 0 } } catch {} ; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
    echo Health check failed. Check the service windows for details.
    exit /b 1
)
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
call "%~dp0STOP_WALLAPOP.bat"
exit /b %errorlevel%

:failed
echo Startup stopped. See the error above.
exit /b 1
