@echo off
echo ==========================================
echo   DC Publish - Safe GitHub Push Tool
echo ==========================================
echo.

cd /d "%~dp0"

:: Check git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git not found!
    echo Download: https://git-scm.com/download/win
    pause
    exit /b
)

:: Set git identity
echo [1/5] Setting git identity...
git config user.email "wbpxy274299@users.noreply.github.com"
git config user.name "wbpxy274299-ai"
echo      Done!

:: Init repo
echo.
echo [2/5] Init git repo...
if not exist ".git" (
    git init
    git remote add origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
    echo      Repo initialized!
) else (
    echo      Repo exists, skip.
)

:: Check if credential is set
echo.
echo [3/5] Checking GitHub credential...
git remote -v | findstr "ghp_" >nul
if %errorlevel% equ 0 (
    echo      Found token in URL, removing...
    git remote set-url origin https://github.com/wbpxy274299-ai/Overseas-Community-Monitor.git
)
echo      URL is clean!

:: Add and commit
echo.
echo [4/5] Adding and committing files...
git add .
git commit -m "update files"

:: Push
echo.
echo [5/5] Pushing to GitHub...
git branch -M main
git push origin main --force

echo.
echo ==========================================
echo   All done!
echo ==========================================
pause
