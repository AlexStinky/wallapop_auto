@echo off
title Wallapop Online Tunnel
color 0B

echo ========================================================
echo        WALLAPOP BOT - Online Tunnel for Phone
echo ========================================================
echo.
echo Connecting to secure tunnel...
echo A link (URL) starting with https:// will appear below.
echo Open that link on your phone (works from Wi-Fi and mobile 4G/5G).
echo.
echo Press Ctrl+C to close the tunnel.
echo ========================================================
echo.

ssh -o StrictHostKeyChecking=no -p 443 -R 0:localhost:3000 a.pinggy.io
pause
