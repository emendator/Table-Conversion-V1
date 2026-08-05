@echo off
:: ============================================================
::  Table Converter - Launcher
::  Detects PowerShell and calls the startup script.
:: ============================================================
setlocal enabledelayedexpansion
title Table Converter

:: Find PowerShell
set "PS_CMD=powershell"
where %PS_CMD% >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PowerShell not found!
    echo This script requires Windows PowerShell 5.1 or later.
    echo Please run on Windows 10 or later.
    pause
    exit /b 1
)

:: Check that startup script exists
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PS1_FILE=%SCRIPT_DIR%\launcher.ps1"
if not exist "%PS1_FILE%" (
    echo [ERROR] %PS1_FILE% not found
    pause
    exit /b 1
)

:: Launch PowerShell script with bypass of execution policy
echo Launching startup script...
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File "%PS1_FILE%"

:: If PowerShell script exits with error, pause
if errorlevel 1 (
    echo.
    echo [ERROR] Startup script failed. Check the output above for details.
    pause
    exit /b 1
)
