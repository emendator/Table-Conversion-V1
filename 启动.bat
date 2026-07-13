@echo off
chcp 65001 >nul
title 表格转换工具

echo.
echo ============================================================
echo   📊 表格转换工具 - 启动中...
echo ============================================================
echo.

cd /d "%~dp0"

:: 检查虚拟环境
if not exist ".venv\Scripts\python.exe" (
    echo ❌ 未找到虚拟环境，请先运行: python -m venv .venv
    pause
    exit /b 1
)

:: 检查依赖
echo 🔍 检查依赖...
.venv\Scripts\python.exe -c "import flask, pandas, openpyxl, requests, PIL" 2>nul
if %errorlevel% neq 0 (
    echo ⚠️ 依赖缺失，正在安装...
    .venv\Scripts\python.exe -m pip install -r requirements.txt -q
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败，请手动执行: pip install -r requirements.txt
        pause
        exit /b 1
    )
    echo ✅ 依赖安装完成
)

:: 创建必要目录
if not exist "uploads" mkdir uploads
if not exist "输出" mkdir 输出

:: 启动服务
echo.
echo 🚀 正在启动 Web 服务...
echo 🌐 浏览器将自动打开 http://127.0.0.1:5000
echo 📌 按 Ctrl+C 停止服务
echo ============================================================
echo.

:: 延迟打开浏览器（等服务器就绪）
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:5000"

:: 启动 Flask
.venv\Scripts\python.exe app.py

pause
