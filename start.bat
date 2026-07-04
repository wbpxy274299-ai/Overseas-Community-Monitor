@echo off
chcp 65001 >nul
echo ========================================
echo   M2G 用户运营后台 - 启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查 Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)
echo ✅ Node.js 已安装

echo.
echo [2/3] 检查依赖...
if not exist "node_modules" (
    echo ⚠️  未找到 node_modules，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
    echo ✅ 依赖安装完成
) else (
    echo ✅ 依赖已存在
)

echo.
echo [3/3] 启动服务...
echo.
echo ========================================
echo   服务即将启动...
echo   - 主界面: http://localhost:5000
echo   - 舆情监控: http://localhost:5000/sentiment
echo ========================================
echo.
echo 按 Ctrl+C 停止服务
echo.

node server.js

pause
