@echo off
title Push to GitHub

echo ============================================
echo   Push to GitHub
echo ============================================
echo.

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Git not found
    echo Install Git: https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

echo [OK] Git found
echo.

if not exist .git (
    echo [INFO] Initializing Git repo...
    git init
    git config user.name "wbpxy274299-ai"
    git config user.email "wbpxy274299-ai@users.noreply.github.com"
    git remote add origin https://wbpxy274299-ai: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@github.com/wbpxy274299-ai/terminology-tool.git
    echo [OK] Done
    echo.
)

echo [INFO] Adding files...
git add .
echo [OK] Files added
echo.

git diff --staged --quiet
if %errorlevel% equ 0 (
    echo [INFO] No changes to push
    echo.
    pause
    exit /b 0
)

for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set dt=%%a
set commit_msg=Update %dt:~0,4%-%dt:~4,2%-%dt:~6,2% %dt:~8,2%:%dt:~10,2%

echo [INFO] Committing...
git commit -m "%commit_msg%"
if %errorlevel% neq 0 (
    echo [ERROR] Commit failed
    pause
    exit /b 1
)
echo [OK] Committed
echo.

echo [INFO] Pushing to GitHub...
git push -u origin main
if %errorlevel% neq 0 (
    echo.
    echo [INFO] Retrying with force...
    git push -u origin main --force
    if %errorlevel% neq 0 (
        echo [ERROR] Push failed
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   Push OK! Vercel will auto-deploy.
echo ============================================
echo.
pause
