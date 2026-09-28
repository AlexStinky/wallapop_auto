@echo off
title Setup Wi-Fi Access
color 0A

:: Check administrator privileges and self-elevate cleanly
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [Info] Requesting Administrator privileges...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ========================================================
echo       CONFIGURING NETWORK AND FIREWALL FOR WI-FI
echo ========================================================
echo.

echo [1/4] Switching Ethernet to Private network...
powershell -Command "Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private"

echo [2/4] Opening port 3000 (Frontend)...
netsh advfirewall firewall delete rule name="Wallapop Port 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes

echo [3/4] Opening port 3001 (Backend)...
netsh advfirewall firewall delete rule name="Wallapop Port 3001" >nul 2>&1
netsh advfirewall firewall add rule name="Wallapop Port 3001" dir=in action=allow protocol=TCP localport=3001 profile=any enable=yes

echo [4/4] Allowing inbound connections for Node.js...
netsh advfirewall firewall delete rule name="NodeJS Wallapop" >nul 2>&1
netsh advfirewall firewall add rule name="NodeJS Wallapop" dir=in action=allow program="X:\nodejs\node.exe" profile=any enable=yes

echo.
echo ========================================================
echo   DONE! Ports 3000, 3001 are open and network is Private.
echo   Now start START_WALLAPOP.bat and connect from phone!
echo ========================================================
echo.
pause
