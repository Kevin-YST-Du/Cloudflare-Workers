#!/bin/bash

# ================= 默认配置 =================
DEFAULT_PORT=21111
DEFAULT_PASSWORD="admin"
APP_NAME="workers"
INSTALL_DIR="/opt/workers"
# ===========================================

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# --- 1. 交互式获取配置 ---
echo -e "${GREEN}🚀 开始安装 WorkerS 服务...${NC}"
echo "--------------------------------"

read -p "请设置服务端口 [默认 $DEFAULT_PORT]: " input_port
PORT=${input_port:-$DEFAULT_PORT}

read -p "请设置访问密码 [默认 $DEFAULT_PASSWORD]: " input_password
PASSWORD=${input_password:-$DEFAULT_PASSWORD}

echo "--------------------------------"
echo -e "📝 即将安装配置: 端口=${GREEN}$PORT${NC}, 密码=${GREEN}$PASSWORD${NC}"
echo "--------------------------------"

# --- 2. 环境检测 ---
if ! command -v node &> /dev/null; then
    echo "📦 未检测到 Node.js，正在安装..."
    if [ -x "$(command -v apt-get)" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [ -x "$(command -v yum)" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs
    elif [ -x "$(command -v apk)" ]; then
        apk add nodejs npm
    else
        echo -e "${RED}❌ 无法自动安装 Node.js，请手动安装后重试。${NC}"
        exit 1
    fi
fi

# --- 3. 部署文件 ---
echo "📂 创建安装目录: $INSTALL_DIR"
# 停止旧服务
systemctl stop $APP_NAME 2>/dev/null

mkdir -p $INSTALL_DIR/src
mkdir -p $INSTALL_DIR/data

# 检查当前目录是否有源文件
if [ ! -f "src/server.js" ] || [ ! -f "package.json" ]; then
    echo -e "${RED}❌ 错误：当前目录下未找到 src/server.js 或 package.json${NC}"
    echo "请确保你是在项目根目录运行此脚本！"
    exit 1
fi

# 复制文件
cp src/server.js $INSTALL_DIR/src/
cp package.json $INSTALL_DIR/

cd $INSTALL_DIR

# --- 4. 生成全量 .env 文件 ---
echo "📄 生成配置文件 (.env)..."
cat > .env <<EOF
# --- 基础配置 ---
PORT=$PORT
PASSWORD="$PASSWORD"
MAX_REDIRECTS=5
ENABLE_CACHE=true
CACHE_TTL=3600

# --- 访问控制 (留空代表允许所有) ---
BLACKLIST=""
WHITELIST=""
ALLOW_IPS=""
ALLOW_COUNTRIES=""

# --- 额度与权限 ---
DAILY_LIMIT_COUNT=200
ADMIN_IPS="127.0.0.1"
IP_LIMIT_WHITELIST="127.0.0.1"
EOF

# --- 5. 安装依赖 ---
echo "📦 安装 NPM 依赖..."
npm install --production

# --- 6. 配置 Systemd ---
echo "⚙️ 配置 Systemd 服务..."
NODE_PATH=$(which node)

cat > /etc/systemd/system/$APP_NAME.service <<EOF
[Unit]
Description=Workers Pro Editor Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
# 加载 .env 环境变量 (Systemd v240+)
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$NODE_PATH src/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- 7. 启动服务 ---
systemctl daemon-reload
systemctl enable $APP_NAME
systemctl restart $APP_NAME

# --- 8. 验证与输出 ---
echo "--------------------------------"
echo -e "${GREEN}✅ 安装完成！服务已启动。${NC}"
echo -e "🌐 访问地址: http://$(curl -s ifconfig.me):$PORT"
echo -e "📂 配置文件: $INSTALL_DIR/.env (修改后需重启服务: systemctl restart $APP_NAME)"
echo -e "🔍 查看状态: systemctl status $APP_NAME"
echo "--------------------------------"