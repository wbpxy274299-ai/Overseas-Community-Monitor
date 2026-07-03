@echo off
chcp 65001 >nul
title Force Push to GitHub (Clean)

echo.
echo ========================================
echo   Force Push - Clean GitHub Repo
echo   Only keep latest code
echo ========================================
echo.

cd /d "%~dp0"

echo [Step 1/7] Delete old git history...
rmdir /s /q .git 2>nul

echo [Step 2/7] Create fresh git repo...
git init

echo [Step 3/7] Set git identity...
git config user.email "wbpxy274299-ai@users.noreply.github.com"
git config user.name "wbpxy274299-ai"

echo [Step 4/7] Connect to GitHub...
git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git

echo [Step 5/7] Add all files...
git add -A

echo [Step 6/7] Commit...
git commit -m "Full reset - latest dc-publish-node code"

echo [Step 7/7] Force push to GitHub...
git push -f origin master

if errorlevel 1 (
    echo.
    echo [ERROR] Push failed! Check network and permissions.
) else (
    echo.
    echo ========================================
    echo   [OK] GitHub is now clean and up to date!
    echo ========================================
)

echo.
pause
