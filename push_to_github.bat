@echo off
echo ==========================================
echo   DC Publish System - GitHub Push Tool
echo ==========================================
echo.

cd /d "%~dp0"

:: Check git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git not found! Please install Git first.
    echo Download: https://git-scm.com/download/win
    pause
    exit /b
)

:: Set git identity
echo [1/4] Setting git identity...
git config user.email "wbpxy274299@users.noreply.github.com"
git config user.name "wbpxy274299-ai"
echo      Done!

:: Init repo
echo.
echo [2/4] Init git repo...
if not exist ".git" (
    git init
    git remote add origin https://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@github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
    echo      Repo initialized!
) else (
    echo      Repo exists, skip.
)

:: Add and commit
echo.
echo [3/4] Adding and committing files...
git add .
git commit -m "update files"

:: Push
echo.
echo [4/4] Pushing to GitHub...
git branch -M main
git push origin main --force

echo.
echo ==========================================
echo   All done!
echo ==========================================
pause
