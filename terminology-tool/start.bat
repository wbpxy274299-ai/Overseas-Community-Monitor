@echo off
chcp 65001 >nul
title Game Terminology Tool + Post Assistant
echo ============================================
echo   Game Terminology Tool + Post Assistant
echo ============================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    echo Please install Node.js: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Found Node.js
echo.

:: 检查是否有 node_modules
if not exist node_modules (
    echo [INFO] Installing dependencies...
    npm install
    echo.
)

echo [OK] Starting server...
node server.js
