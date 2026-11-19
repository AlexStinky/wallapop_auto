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

echo Разрешение доступа к интерфейсу из локальной подсети...
netsh advfirewall firewall delete rule name="Wallapop Port 3000" >nul 2>&1
netsh advfirewall firewall delete rule name="Wallapop Port 3001" >nul 2>&1
netsh advfirewall firewall delete rule name="NodeJS Wallapop" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3000" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet profile=private enable=yes || exit /b 1

set LOCAL_IP=
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -ExpandProperty IPv4Address | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
if "%LOCAL_IP%"=="" (
    for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|WSL' -and $_.IPAddress -notmatch '^127\.|^169\.254\.' } | Select-Object -ExpandProperty IPAddress -First 1)"') do set LOCAL_IP=%%a
)

echo.
echo ========================================================
echo   ГОТОВО! Порт 3000 открыт для локальной подсети в частной сети.
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
