@echo off
echo ==========================================
echo   DC Publish System - GitHub Push Tool
echo ==========================================
echo.

cd /d "%~dp0"

if not exist ".git" (
    echo [1/4] Init git repo...
    git init
    git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
) else (
    echo [1/4] Git repo exists, skip init
)

echo.
echo [2/4] Adding files...
git add .

echo.
echo [3/4] Committing...
git commit -m "update files"

echo.
echo [4/4] Pushing to GitHub...
git push origin main --force

echo.
echo ==========================================
echo   Done!
echo ==========================================
pause
