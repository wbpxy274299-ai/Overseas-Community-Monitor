@echo off
chcp 65001 >nul 2>nul
echo ==========================================
echo   一键部署：GitHub + Vultr 服务器
echo ==========================================
echo.

cd /d "%~dp0"

:: ===== 服务器配置 =====
set SERVER_IP=198.13.60.172
set SERVER_USER=root
set SERVER_DIR=/dc-publish
set PM2_NAME=dc-publish

:: ===== 第一步：推送代码到 GitHub =====
echo [第一步] 推送到 GitHub...
echo.

:: 检查 git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 没找到 git！
    pause
    exit /b
)

:: 设置 git 身份
git config user.email "wbpxy274299@users.noreply.github.com"
git config user.name "wbpxy274299-ai"

:: 检查 remote
git remote get-url origin >nul 2>nul
if %errorlevel% neq 0 (
    git init
    git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
    git branch -M main
)

:: 检查改动
git add .
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo [跳过] 没有新改动，直接同步服务器...
    goto :deploy
)

:: 统计文件数
for /f %%i in ('git diff --cached --name-only ^| find /c /v ""') do set FILE_COUNT=%%i

:: 生成 commit 信息
for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set DT=%%a
set COMMIT_DATE=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
set COMMIT_MSG=deploy %COMMIT_DATE% (%FILE_COUNT% files)

echo 提交 %FILE_COUNT% 个文件...
git commit -m "%COMMIT_MSG%"
if %errorlevel% neq 0 (
    echo [错误] 提交失败！
    pause
    exit /b
)

git push origin main
if %errorlevel% neq 0 (
    echo 普通推送失败，尝试强制推送...
    git push origin main --force
    if %errorlevel% neq 0 (
        echo [错误] GitHub 推送失败！
        pause
        exit /b
    )
)

echo [OK] GitHub 推送完成
echo.

:: ===== 第二步：同步到 Vultr 服务器 =====
:deploy
echo [第二步] 同步到 Vultr 服务器...
echo.
echo 正在连接 %SERVER_IP%（可能需要输入服务器密码）
echo.

ssh %SERVER_USER%@%SERVER_IP% "cd %SERVER_DIR% && echo '--- 拉取最新代码 ---' && git pull origin main && echo '--- 重启服务 ---' && pm2 restart %PM2_NAME% && echo '' && echo '=== 部署完成 ===' && pm2 status"

if %errorlevel% neq 0 (
    echo.
    echo [错误] 服务器同步失败！
    echo 可能原因：
    echo   1. 服务器密码错误
    echo   2. 网络连不上（检查代理/VPN）
    echo   3. SSH 连接超时
    echo.
    echo 你也可以手动 SSH 登录后执行：
    echo   cd %SERVER_DIR% ^&^& git pull origin main ^&^& pm2 restart %PM2_NAME%
    echo.
    pause
    exit /b
)

echo.
echo ==========================================
echo   部署完成！代码已同步到 Vultr 服务器
echo   访问：http://test-posting.xyz
echo ==========================================
pause
