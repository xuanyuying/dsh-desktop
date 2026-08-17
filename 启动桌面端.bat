@echo off
rem ============================================
rem  DSH Desktop - DeepSeek Harness desktop launcher
rem  Double-click to start (requires Node.js)
rem  No Visual Studio / IDE required
rem ============================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

rem Use project-local npm cache to avoid permission issues
set "npm_config_cache=%~dp0.npm-cache"
set "ELECTRON_CACHE=%~dp0.electron-cache"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

rem ---- Auto install dependencies on first run ----
if not exist node_modules\electron\dist\electron.exe (
    echo [DSH Desktop] First run: installing dependencies, please wait (2-5 min)...
    call npm install --ignore-scripts --no-audit --no-fund
    if errorlevel 1 (
        echo [DSH Desktop] Dependency install failed. Check network and retry.
        pause
        exit /b 1
    )
    if not exist .electron-cache\electron-v43.4.0-win32-x64.zip (
        echo [DSH Desktop] Downloading Electron runtime...
        node scripts\download-electron.js
        if errorlevel 1 (
            echo [DSH Desktop] Electron download failed. Check network and retry.
            pause
            exit /b 1
        )
    )
    node scripts\extract-electron.js
    if errorlevel 1 (
        echo [DSH Desktop] Electron extract failed.
        pause
        exit /b 1
    )
)

echo [DSH Desktop] Starting DeepSeek Harness ...
call npx electron .
endlocal