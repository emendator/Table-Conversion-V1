<#
.SYNOPSIS
    Table Converter - Portable Startup Script (PowerShell)
.DESCRIPTION
    Automatically detects environment, installs dependencies,
    and starts both backend and frontend services.
    Works on any Windows 10/11 computer.
#>

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Yellow }
function Write-OK($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  ... $msg" -ForegroundColor Cyan }
function Write-Error($msg) { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

# ---------- Helper: test if venv python is usable ----------
function Test-VenvPython($exePath) {
    if (-not (Test-Path $exePath)) { return $false }
    try {
        $ver = & $exePath --version 2>&1
        return ($LASTEXITCODE -eq 0 -and $ver -match "Python")
    }
    catch { return $false }
}

# ---------- Helper: recreate venv ----------
function New-Venv {
    param([string]$ScriptDir, [string]$pythonCmd)
    Write-Info "Creating virtual environment..."
    Push-Location $ScriptDir
    try {
        & $pythonCmd -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    }
    finally { Pop-Location }
    Write-OK "Virtual environment created"
}

# Get project root (script directory)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $ScriptDir "backend"
$FrontendDir = Join-Path $ScriptDir "frontend"
$VenvDir = Join-Path $ScriptDir ".venv"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Table Converter - Portable Launcher" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Project: $ScriptDir`n"

# ============================================================
#  Step 1: Check Python
# ============================================================
Write-Step "[1/5] Checking Python..."

$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0 -and $ver -match "Python") {
            $pythonCmd = $cmd
            break
        }
    }
    catch {}
}

if (-not $pythonCmd) {
    Write-Error "Python 3 not found!"
    Write-Host "Please install Python 3.8+ from https://www.python.org/downloads/"
    Write-Host "Make sure to check 'Add Python to PATH' during installation.`n"
    Read-Host "Press Enter to exit"
    exit 1
}

$pythonVersion = & $pythonCmd --version 2>&1
Write-OK $pythonVersion

# ============================================================
#  Step 2: Check Node.js
# ============================================================
Write-Step "[2/5] Checking Node.js..."

try {
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "node not found" }
}
catch {
    Write-Error "Node.js not found!"
    Write-Host "Please install Node.js 18+ (LTS) from https://nodejs.org/`n"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-OK "Node.js $nodeVersion"

# ============================================================
#  Step 3: Setup Python virtual environment
# ============================================================
Write-Step "[3/5] Setting up Python environment..."

$pythonExe = Join-Path (Join-Path $VenvDir "Scripts") "python.exe"

# Check if venv exists AND is usable (survives copying to another PC)
if (Test-VenvPython $pythonExe) {
    Write-OK "Virtual environment is usable"
}
else {
    # Venv either doesn't exist or is broken (e.g. copied from another PC)
    if (Test-Path $VenvDir) {
        Write-Info "Virtual environment is broken (possibly from another computer). Recreating..."
        Remove-Item -Path $VenvDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Venv -ScriptDir $ScriptDir -pythonCmd $pythonCmd
}

# Verify the venv works after creation/repair
if (-not (Test-VenvPython $pythonExe)) {
    Write-Error "Failed to create usable virtual environment!"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Info "Installing Python dependencies..."
Push-Location $ScriptDir
try {
    $pipResult = & $pythonExe -m pip install --upgrade pip -q 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ... pip upgrade failed (non-fatal): $pipResult"
    }
    
    $installResult = & $pythonExe -m pip install -r (Join-Path $BackendDir "requirements.txt") 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ... Retrying with verbose output..."
        $installResult = & $pythonExe -m pip install -r (Join-Path $BackendDir "requirements.txt") 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pip install failed!"
            Write-Host "$installResult"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }
}
finally { Pop-Location }
Write-OK "Python dependencies installed"

# ============================================================
#  Step 4: Install frontend dependencies
# ============================================================
Write-Step "[4/5] Installing frontend dependencies..."

if (Test-Path (Join-Path $FrontendDir "node_modules")) {
    Write-OK "node_modules exists"
}
else {
    Write-Info "Running npm install (first time may take a few minutes)..."
    Push-Location $FrontendDir
    try {
        npm install 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    finally { Pop-Location }
    Write-OK "npm install complete"
}
Write-OK "Frontend ready"

# ============================================================
#  Step 5: Start services
# ============================================================
Write-Step "[5/5] Starting services..."

# Kill any leftover processes
function Cleanup {
    Write-Info "Cleaning up service processes..."
    # Kill by window title (Start-Process with -PassThru sets MainWindowTitle)
    Get-Process | Where-Object { $_.MainWindowTitle -eq "BE-Server" -or $_.MainWindowTitle -eq "FE-Server" } | Stop-Process -Force -ErrorAction SilentlyContinue
    # Fallback: kill any uvicorn/vite processes from this project
    Get-Process "python" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "uvicorn" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "vite" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

Cleanup

# Start backend
Write-Info "Starting backend API server..."
$backendJob = Start-Process -FilePath $pythonExe -ArgumentList "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8004", "--reload", "--log-level", "info" -WorkingDirectory $BackendDir -PassThru -WindowStyle Normal

# Wait for backend
Write-Info "Waiting for backend (this may take 10-15s)..."
$backendReady = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8004/' -UseBasicParsing -TimeoutSec 1
        if ($r.StatusCode -eq 200) {
            $backendReady = $true
            break
        }
    }
    catch {}
    Start-Sleep -Seconds 1
}

if (-not $backendReady) {
    Write-Error "Backend did not become ready in time"
    Write-Host "Check the backend window for errors"
    Cleanup
    Read-Host "Press Enter to exit"
    exit 1
}

Write-OK "Backend running at http://127.0.0.1:8004"

# Start frontend
Write-Info "Starting frontend dev server..."
$frontendJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $FrontendDir -PassThru -WindowStyle Normal

# Wait briefly then open browser
Start-Sleep -Seconds 4
Write-Info "Opening browser..."
Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:3002"

# ============================================================
#  Display status screen
# ============================================================
Clear-Host
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "   Table Converter - Running" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "`n  Backend API:  http://127.0.0.1:8004" -ForegroundColor Cyan
Write-Host "  Frontend UI:  http://127.0.0.1:3002" -ForegroundColor Cyan
Write-Host "  API Docs:     http://127.0.0.1:8004/docs" -ForegroundColor Cyan
Write-Host "`n  Close this window to stop all services." -ForegroundColor Yellow
Write-Host "`n  Press any key to stop all services and exit..." -ForegroundColor Yellow
Read-Host

# Cleanup on exit
Cleanup
Write-Host "`nServices stopped. Thank you!" -ForegroundColor Green
Start-Sleep -Seconds 2
