@echo off
chcp 65001 >nul
title 表格转换工具 - React + FastAPI

echo.
echo ============================================================
echo   📊 表格转换工具 - React + FastAPI 架构
echo ============================================================
echo.

cd /d "%~dp0"

:: 检查虚拟环境
if not exist ".venv\Scripts\python.exe" (
    echo ❌ 未找到虚拟环境，请先运行: python -m venv .venv
    pause
    exit /b 1
)

:: 检查后端依赖
echo 🔍 检查后端依赖...
.venv\Scripts\python.exe -c "import fastapi, pandas, openpyxl, requests, PIL" 2>nul
if %errorlevel% neq 0 (
    echo ⚠️ 后端依赖缺失，正在安装...
    .venv\Scripts\python.exe -m pip install -r backend\requirements.txt -q
    if %errorlevel% neq 0 (
        echo ❌ 安装失败，请手动执行: pip install -r backend\requirements.txt
        pause
        exit /b 1
    )
    echo ✅ 后端依赖安装完成
)

:: 检查前端依赖
if not exist "frontend\node_modules" (
    echo ⚠️ 前端依赖缺失，正在安装...
    cd frontend && npm install && cd ..
    if %errorlevel% neq 0 (
        echo ❌ 前端依赖安装失败，请手动进入 frontend 目录执行 npm install
        pause
        exit /b 1
    )
    echo ✅ 前端依赖安装完成
)

:: 创建必要目录
if not exist "backend\uploads" mkdir backend\uploads
if not exist "backend\输出" mkdir backend\输出

echo.
echo ============================================================
echo   🚀 启动服务（React + FastAPI 架构）
echo ============================================================
echo.
echo   🔧 后端 API 服务: http://127.0.0.1:8004
echo   🖥️  前端界面:    http://127.0.0.1:3002
echo   📖 API 文档:     http://127.0.0.1:8004/docs
echo.
echo   ⚠️  请勿关闭此窗口（关闭将停止所有服务）
echo ============================================================
echo.

:: 启动后端 API 服务（后台窗口）
echo 🔧 启动 FastAPI 后端服务...
start "表格转换-API" /MIN cmd /c "cd /d "%~dp0backend" && ..\.venv\Scripts\python.exe app.py"

:: 等待后端启动
echo ⏳ 等待后端服务就绪...
timeout /t 4 /nobreak >nul

:: 启动前端开发服务器（后台窗口）
echo 🖥️ 启动 React 前端服务...
start "表格转换-前端" /MIN cmd /c "cd /d "%~dp0frontend" && npm run dev"

:: 等待前端启动
timeout /t 3 /nobreak >nul

:: 打开浏览器
echo 🌐 打开浏览器...
start http://127.0.0.1:3002

echo.
echo ✅ 全部服务已启动！
echo.
echo   📋 后端 API:  http://127.0.0.1:8004
echo   🌐 前端界面:  http://127.0.0.1:3002
echo   📖 API 文档:  http://127.0.0.1:8004/docs
echo.
echo   按任意键停止所有服务...
pause >nul

:: 清理后台进程
taskkill /FI "WINDOWTITLE eq 表格转换-API*" /T /F 2>nul
taskkill /FI "WINDOWTITLE eq 表格转换-前端*" /T /F 2>nul
echo 👋 服务已停止
pause
