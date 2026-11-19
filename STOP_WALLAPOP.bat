@echo off
title Wallapop Bot Stopper
color 0C

echo ========================================================
echo           WALLAPOP BOT - Stopping Services
echo ========================================================
echo.

echo Stopping the Wallapop service windows and their child processes...
taskkill /t /f /im cmd.exe /fi "WINDOWTITLE eq Wallapop Backend*" >nul 2>&1
taskkill /t /f /im cmd.exe /fi "WINDOWTITLE eq Wallapop Frontend*" >nul 2>&1

echo.
echo ========================================================
echo   Wallapop service stop requested.
echo ========================================================
ping -n 3 127.0.0.1 >nul
