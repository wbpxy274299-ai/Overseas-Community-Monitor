@echo off
chcp 65001 >nul 2>nul
echo ==========================================
echo   一键推送到 GitHub
echo ==========================================
echo.

cd /d "%~dp0"

:: 检查 git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 没找到 git！
    echo 下载地址: https://git-scm.com/download/win
    pause
    exit /b
)

:: 设置 git 身份（只设本地，不影响全局）
git config user.email "wbpxy274299@users.noreply.github.com"
git config user.name "wbpxy274299-ai"

:: 检查 remote
git remote get-url origin >nul 2>nul
if %errorlevel% neq 0 (
    echo [初始化] 创建 git 仓库...
    git init
    git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
    git branch -M main
)

:: 检查有没有改动
git add .
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo.
    echo [完成] 没有任何改动，不需要推送。
    echo.
    pause
    exit /b
)

:: 统计改动文件数
for /f %%i in ('git diff --cached --name-only ^| find /c /v ""') do set FILE_COUNT=%%i

:: 生成 commit 信息（日期 + 文件数）
for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set DT=%%a
set COMMIT_DATE=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
set COMMIT_MSG=update %COMMIT_DATE% (%FILE_COUNT% files)

echo [1/2] 提交 %FILE_COUNT% 个文件...
echo      信息: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"
if %errorlevel% neq 0 (
    echo [错误] 提交失败！
    pause
    exit /b
)

echo.
echo [2/2] 推送到 GitHub...
git push origin main
if %errorlevel% neq 0 (
    echo.
    echo [提示] 普通推送失败，尝试强制推送...
    git push origin main --force
    if %errorlevel% neq 0 (
        echo [错误] 推送失败！请检查网络或 GitHub 凭证。
        pause
        exit /b
    )
)

echo.
echo ==========================================
echo   推送完成！ %FILE_COUNT% 个文件已更新到 GitHub
echo ==========================================
pause
