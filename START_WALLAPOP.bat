@echo off
chcp 65001 >nul
title Wallapop Bot Launcher
color 0A

echo ========================================================
echo           WALLAPOP BOT - Launching Services
echo ========================================================
echo.

cd /d "%~dp0" || goto :failed

:: Ensure MongoDB service is running if installed
net start MongoDB >nul 2>&1

:: Detect local IP address dynamically using node
set LOCAL_IP=
if exist "%~dp0get-ip.js" (
    for /f "delims=" %%a in ('node "%~dp0get-ip.js"') do set LOCAL_IP=%%a
)
if "%LOCAL_IP%"=="" set LOCAL_IP=localhost

echo Checking service ports...
powershell -NoProfile -Command "try { $ports = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port } catch { Write-Error $_; exit 2 }; if ($ports -match '^(3000|3001)$') { exit 1 }; exit 0"
if errorlevel 2 goto :failed
if errorlevel 1 goto :checkRunningSite

echo Updating code from Git...
git pull --ff-only || goto :failed

node "%~dp0prepare-launch.js" || goto :failed

echo - Starting Backend (port 3001)...
set "HOST=127.0.0.1"
start "Wallapop Backend" /D "%~dp0backend" cmd /d /k "title Wallapop Backend && node .launcher-dist/index.js"

echo - Starting Frontend (port 3000)...
start "Wallapop Frontend" /D "%~dp0frontend" cmd /d /k "title Wallapop Frontend && npm start"

echo.
echo Waiting for the frontend...
powershell -NoProfile -Command "foreach ($attempt in 1..30) { try { Invoke-WebRequest 'http://127.0.0.1:3000/' -Method Head -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null; exit 0 } catch {}; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
    echo Frontend did not respond. Check the frontend window for details.
    exit /b 1
)
call :openBrowser || goto :failed

echo Waiting for the backend...
call :waitForBackend 30
if errorlevel 1 (
    echo Health check failed. Check the service windows for details.
    exit /b 1
)

echo.
echo ========================================================
echo   Wallapop Bot ЗАПУЩЕННО!
echo.
echo   ПК:         http://localhost:3000
echo   Телефон (Wi-Fi):   http://%LOCAL_IP%:3000
echo.
echo   ------------------------------------------------------
echo   ВАЖЛИВО ДЛЯ ВХОДУ З ТЕЛЕФОНУ:
echo   - Телефон має бути підключенний до того ж Wi-Fi!
echo   - Якщо не відкривається на телефоні, запустіть один раз
echo     ALLOW_FIREWALL.bat від імені адміністратора.
echo.
echo   Натисніть будь-яку клавішу для ЗУПИНКИ всіх сервісів.
echo ========================================================
pause >nul

echo.
call "%~dp0STOP_WALLAPOP.bat"
exit /b %errorlevel%

:checkRunningSite
call :waitForBackend 1
if errorlevel 1 (
    echo Port 3000 or 3001 is in use. Close the existing service before launching.
    exit /b 1
)
echo Wallapop is already running.
call :openBrowser || goto :failed
exit /b 0

:openBrowser
echo Opening browser: http://localhost:3000
start "" "http://localhost:3000"
exit /b %errorlevel%

:waitForBackend
powershell -NoProfile -Command "foreach ($attempt in 1..%~1) { try { $health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 2 -ErrorAction Stop; if ($health.status -eq 'ok') { exit 0 } } catch {}; if ($attempt -lt %~1) { Start-Sleep -Seconds 1 } }; exit 1"
exit /b %errorlevel%

:failed
echo Startup stopped. See the error above.
exit /b 1
