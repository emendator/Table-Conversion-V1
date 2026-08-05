#!/usr/bin/env bash
# ============================================================
# 表格转换工具 - Ubuntu 云服务器一键部署脚本
#
# 前提：
#   1. 项目已上传到 /opt/table-converter（含 backend/ frontend/ deploy/ data/）
#   2. 系统为 Ubuntu 20.04 / 22.04 / 24.04
#
# 用法：
#   cd /opt/table-converter
#   sudo bash deploy/deploy.sh            # 默认 80 端口（需备案/海外节点）
#   sudo bash deploy/deploy.sh 8080       # 内地未备案时，用 8080 免备案访问
#
# 会执行：
#   ① 系统依赖  ② Node.js  ③ 后端依赖  ④ 前端构建
#   ⑤ systemd 服务  ⑥ Nginx  ⑦ 防火墙
# ============================================================
set -euo pipefail

# 访问端口：默认 80；内地服务器未备案可传 8080（访问 http://IP:8080）
PORT="${1:-80}"
case "$PORT" in
    ''|*[!0-9]*) echo "[ERROR] 端口必须是数字，例如: sudo bash deploy/deploy.sh 8080"; exit 1;;
esac

APP_DIR="/opt/table-converter"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
DEPLOY_DIR="$APP_DIR/deploy"

echo "============================================================"
echo "  表格转换工具 - 云服务器一键部署"
echo "============================================================"

if [ ! -d "$BACKEND_DIR" ]; then
    echo "[ERROR] 找不到 $BACKEND_DIR"
    echo "        请先把项目上传到 $APP_DIR 后再运行本脚本"
    exit 1
fi

# ---------- 1. 系统依赖 ----------
echo ""
echo "[1/7] 更新系统并安装基础依赖..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx python3 python3-venv python3-pip curl

# ---------- 2. Node.js ----------
echo ""
echo "[2/7] 安装 Node.js 20 LTS..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "  Node.js: $(node --version)"
# 国内服务器加速 npm 下载
npm config set registry https://registry.npmmirror.com 2>/dev/null || true

# ---------- 3. 后端依赖 ----------
echo ""
echo "[3/7] 创建 Python 虚拟环境并安装依赖..."
cd "$BACKEND_DIR"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
# 国内服务器加速 pip 下载
.venv/bin/pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null || true
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

# ---------- 4. 前端构建 ----------
echo ""
echo "[4/7] 构建前端页面..."
cd "$FRONTEND_DIR"
npm install --no-audit --no-fund
npm run build

# ---------- 5. systemd 后端服务 ----------
echo ""
echo "[5/7] 配置后端 systemd 服务..."
cp "$DEPLOY_DIR/table-converter.service" /etc/systemd/system/table-converter.service
chown -R www-data:www-data "$APP_DIR"
systemctl daemon-reload
systemctl enable table-converter
systemctl restart table-converter

# ---------- 6. Nginx ----------
echo ""
echo "[6/7] 配置 Nginx..."
cp "$DEPLOY_DIR/nginx.conf" /etc/nginx/sites-available/table-converter
# 按指定端口替换监听端口（默认 80）
sed -i "s/listen 80;/listen $PORT;/" /etc/nginx/sites-available/table-converter
ln -sf /etc/nginx/sites-available/table-converter /etc/nginx/sites-enabled/table-converter
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

# ---------- 7. 防火墙 ----------
echo ""
echo "[7/7] 配置防火墙..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH
    ufw allow "$PORT/tcp"
    ufw --force enable
fi

# 获取公网 IP（用于最后提示）
IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ip.sb 2>/dev/null || echo "你的服务器公网IP")
if [ "$PORT" = "80" ]; then
    ACCESS_URL="http://$IP"
else
    ACCESS_URL="http://$IP:$PORT"
fi

echo ""
echo "============================================================"
echo "  ✅ 部署完成！"
echo "------------------------------------------------------------"
echo "  访问地址:  $ACCESS_URL"
echo "  登录账号:  admin"
echo "  登录密码:  ***REMOVED***   （登录后请尽快修改！）"
echo ""
echo "  常用命令:"
echo "    查看后端日志:  journalctl -u table-converter -f"
echo "    重启后端:      systemctl restart table-converter"
echo "    重载 Nginx:    nginx -t && systemctl reload nginx"
echo "============================================================"
