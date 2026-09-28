@echo off
title Настройка доступа по Wi-Fi
color 0A

:: Проверка прав администратора и запрос повышения
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Запрос прав администратора...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~fn0\"\"' -Verb RunAs"
    exit /b
)

echo ========================================================
echo       НАСТРОЙКА СЕТИ И БРАНДМАУЭРА ДЛЯ WI-FI
echo ========================================================
echo.

echo [1/4] Переключение сети в режим "Частная сеть"...
powershell -Command "Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private" >nul 2>&1

echo [2/4] Открытие порта 3000 (Фронтенд)...
netsh advfirewall firewall delete rule name="Wallapop Port 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes >nul 2>&1

echo [3/4] Открытие порта 3001 (Бэкенд)...
netsh advfirewall firewall delete rule name="Wallapop Port 3001" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3001" dir=in action=allow protocol=TCP localport=3001 profile=any enable=yes >nul 2>&1

echo [4/4] Разрешение входящих подключений для Node.js...
netsh advfirewall firewall delete rule name="NodeJS Wallapop" >nul 2>&1
netsh advfirewall firewall add rule name="NodeJS Wallapop" dir=in action=allow program="X:\nodejs\node.exe" profile=any enable=yes >nul 2>&1

echo.
echo ========================================================
echo   УСПЕШНО! Все порты открыты и сеть переведена в Частную.
echo   Теперь телефон сможет подключаться по Wi-Fi!
echo ========================================================
echo.
pause
