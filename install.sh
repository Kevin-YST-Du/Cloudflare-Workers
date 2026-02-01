#!/bin/bash

# ================= 默认配置 =================
DEFAULT_PORT=21020
INSTALL_DIR="/opt/workers"
# ===========================================

# --- 1. 基础信息获取 ---
echo "🚀 开始安装 Workers Pro Editor (Node.js 源码版)..."
echo "--------------------------------"

read -p "请设置服务端口 [默认 $DEFAULT_PORT]: " input_port
PORT=${input_port:-$DEFAULT_PORT}

echo "--------------------------------"

# --- 2. 环境检测 (Node.js & 编译工具) ---
echo "🔍 检查运行环境..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "📦 未检测到 Node.js，正在安装..."
    if [ -x "$(command -v apt-get)" ]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs build-essential python3
    elif [ -x "$(command -v yum)" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
        sudo yum install -y nodejs python3 make gcc-c++
    elif [ -x "$(command -v apk)" ]; then
        apk add nodejs npm python3 make g++
    else
        echo "❌ 无法自动安装 Node.js，请手动安装后重试。"
        exit 1
    fi
else
    # 即使有 Node，也要确保有编译工具 (better-sqlite3 需要)
    echo "✅ 检测到 Node.js，正在检查编译工具..."
    if [ -x "$(command -v apt-get)" ]; then
        sudo apt-get install -y build-essential python3
    elif [ -x "$(command -v yum)" ]; then
        sudo yum install -y python3 make gcc-c++
    elif [ -x "$(command -v apk)" ]; then
        apk add python3 make g++
    fi
fi

# --- 3. 部署文件 ---
echo "📂 创建安装目录: $INSTALL_DIR"
# 如果正在运行，尝试停止
systemctl stop workers 2>/dev/null
rm -rf $INSTALL_DIR
mkdir -p $INSTALL_DIR/src

# [关键] 创建数据目录，确保 SQLite 可写入
mkdir -p $INSTALL_DIR/data
chmod 777 $INSTALL_DIR/data

# 检查当前目录是否有源文件
if [ ! -f "src/server.js" ] || [ ! -f "package.json" ]; then
    echo "❌ 错误：当前目录下未找到 src/server.js 或 package.json"
    echo "请确保你是在项目根目录运行此脚本！"
    exit 1
fi

echo "📦 复制源文件..."
cp src/server.js $INSTALL_DIR/src/
cp package.json $INSTALL_DIR/

cd $INSTALL_DIR

# --- 4. 安装依赖 ---
echo "📦 安装 NPM 依赖 (包括编译 SQLite)..."
# 这一步会自动编译 better-sqlite3，可能需要几分钟
npm install --production

# --- 5. 配置 Systemd ---
echo "⚙️ 配置 Systemd 服务..."
# 获取 node 的绝对路径
NODE_PATH=$(which node)
cat > /etc/systemd/system/workers.service <<EOF
[Unit]
Description=Workers Pro Editor Node Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
# 增加 Node 内存限制，防止 OOM
Environment=NODE_OPTIONS="--max-old-space-size=4096"
# 设置应用环境变量
Environment="PORT=$PORT"
Environment="DB_PATH=$INSTALL_DIR/data/database.sqlite"

ExecStart=$NODE_PATH src/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- 6. 自动放行防火墙端口 ---
echo "🛡️ 正在尝试开启防火墙端口: $PORT"
if command -v ufw >/dev/null 2>&1; then
    ufw allow $PORT/tcp >/dev/null 2>&1
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=$PORT/tcp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
else
    echo "⚠️ 未检测到 UFW 或 FirewallD，如果无法访问请手动检查防火墙设置。"
fi

# --- 7. 启动服务 ---
systemctl daemon-reload
systemctl enable workers
systemctl restart workers

# --- 8. 验证与输出 ---
PUBLIC_IP=$(curl -s ifconfig.me || echo "你的服务器IP")
echo "--------------------------------"
echo "✅ 安装完成！(Node.js 源码版)"
echo "🌐 访问地址: http://$PUBLIC_IP:$PORT/"
echo "📂 数据目录: $INSTALL_DIR/data (SQLite数据库)"
echo "🔍 查看状态: systemctl status workers"
echo "--------------------------------"
