@echo off
chcp 936 >nul 2>nul
echo ==========================================
echo   Deploy: GitHub + Vultr Server
echo ==========================================
echo.

cd /d "%~dp0"

:: ===== Server Config =====
set SERVER_IP=198.13.60.172
set SERVER_USER=root
set SERVER_DIR=/dc-publish
set PM2_NAME=dc-publish

:: ===== Step 1: Push to GitHub =====
echo [Step 1] Push to GitHub...
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] git not found!
    pause
    exit /b
)

git config user.email "wbpxy274299@users.noreply.github.com"
git config user.name "wbpxy274299-ai"

git remote get-url origin >nul 2>nul
if %errorlevel% neq 0 (
    git init
    git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
    git branch -M main
)

git add .
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo [SKIP] No changes, sync server directly...
    goto :deploy
)

for /f %%i in ('git diff --cached --name-only ^| find /c /v ""') do set FILE_COUNT=%%i

for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set DT=%%a
set COMMIT_DATE=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
set COMMIT_MSG=deploy %COMMIT_DATE% (%FILE_COUNT% files)

echo Committing %FILE_COUNT% files...
git commit -m "%COMMIT_MSG%"
if %errorlevel% neq 0 (
    echo [ERROR] Commit failed!
    pause
    exit /b
)

git push origin main
if %errorlevel% neq 0 (
    echo Force pushing...
    git push origin main --force
    if %errorlevel% neq 0 (
        echo [ERROR] Push failed! Check network or GitHub credentials.
        pause
        exit /b
    )
)

echo [OK] GitHub push complete
echo.

:: ===== Step 2: Sync to Vultr =====
:deploy
echo [Step 2] Sync to Vultr server...
echo.
echo Connecting to %SERVER_IP%...
echo.

ssh %SERVER_USER%@%SERVER_IP% "cd %SERVER_DIR% && echo '--- git pull ---' && git pull origin main && echo '--- restart pm2 ---' && pm2 restart %PM2_NAME% && echo '' && echo '=== Deploy done ===' && pm2 status"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server sync failed!
    echo.
    echo Fix: run this on your PC:
    echo   ssh-keygen -R %SERVER_IP%
    echo Then run deploy.bat again and type yes
    echo.
    echo Or SSH manually and run:
    echo   cd %SERVER_DIR% ^&^& git pull origin main ^&^& pm2 restart %PM2_NAME%
    echo.
    pause
    exit /b
)

echo.
echo ==========================================
echo   Deploy done! Vultr server updated.
echo   Visit: https://test-posting.xyz
echo ==========================================
pause
