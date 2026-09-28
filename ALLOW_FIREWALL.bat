@echo off
chcp 65001 >nul
title Настройка доступа по Wi-Fi для Wallapop
color 0A

:: Check administrator privileges and self-elevate cleanly
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [Info] Запрос прав администратора...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ========================================================
echo   НАСТРОЙКА СЕТИ И БРАНДМАУЭРА ДЛЯ ДОСТУПА ПО WI-FI
echo ========================================================
echo.

echo [1/4] Переключение активных сетевых подключений в Частную сеть (Private)...
powershell -NoProfile -Command "Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue"

echo [2/4] Открытие порта 3000 (Frontend)...
netsh advfirewall firewall delete rule name="Wallapop Port 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes >nul 2>&1

echo [3/4] Открытие порта 3001 (Backend)...
netsh advfirewall firewall delete rule name="Wallapop Port 3001" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3001" dir=in action=allow protocol=TCP localport=3001 profile=any enable=yes >nul 2>&1

echo [4/4] Разрешение входящих подключений для Node.js...
netsh advfirewall firewall delete rule name="NodeJS Wallapop" >nul 2>&1
for /f "delims=" %%i in ('where node 2^>nul') do (
    netsh advfirewall firewall add rule name="NodeJS Wallapop" dir=in action=allow program="%%i" profile=any enable=yes >nul 2>&1
)

:: Определение локального IP-адреса
set LOCAL_IP=
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -ExpandProperty IPv4Address | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
if "%LOCAL_IP%"=="" (
    for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|WSL' -and $_.IPAddress -notmatch '^127\.|^169\.254\.' } | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
)

echo.
echo ========================================================
echo   ГОТОВО! Порты 3000 и 3001 открыты в брандмауэре Windows.
echo   Сеть успешно переведена в Частную (Private).
echo.
if not "%LOCAL_IP%"=="" (
    echo   ССЫЛКА ДЛЯ ВХОДА С ТЕЛЕФОНА:
    echo   http://%LOCAL_IP%:3000
    echo.
)
echo   ИНСТРУКЦИЯ:
echo   1. Убедитесь, что телефон подключен к тому же Wi-Fi.
echo   2. Запустите START_WALLAPOP.bat на компьютере.
echo   3. Откройте указанную выше ссылку в браузере телефона.
echo ========================================================
echo.
pause
