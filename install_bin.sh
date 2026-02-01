#!/bin/bash

# ================= 默认配置 =================
DEFAULT_PORT=21020
INSTALL_DIR="/opt/workers"
BINARY_NAME="workers"
# ===========================================

# --- 0. 自动识别架构并寻找对应文件 ---
ARCH=$(uname -m)
case $ARCH in
    x86_64)  
        TARGET_FILE="workers-linux"
        ;;
    aarch64|arm64) 
        # 注意：目前 GitHub Action 暂未配置 arm64 的构建，如果后续加上了，这里对应文件名
        # 暂时回落到 linux (通常指 x64) 或者报错提示
        TARGET_FILE="workers-linux-arm64" 
        echo "⚠️  注意: ARM64 架构支持取决于你的 Release 是否包含对应文件"
        ;;
    *)
        echo "❌ 不支持的系统架构: $ARCH"
        exit 1
        ;;
esac

echo "🔍 检测到系统架构为: $ARCH"

# 检查当前目录下是否有对应的二进制文件
if [ -f "$TARGET_FILE" ]; then
    echo "📦 找到匹配的文件: $TARGET_FILE"
    echo "🔄 正在重命名为 $BINARY_NAME 并赋予权限..."
    cp "$TARGET_FILE" "$BINARY_NAME" # 使用 cp 保留原文件
    chmod +x "$BINARY_NAME"
elif [ -f "$BINARY_NAME" ]; then
    echo "✅ 已存在 $BINARY_NAME，正在确保执行权限..."
    chmod +x "$BINARY_NAME"
else
    echo "❌ 错误：当前目录下未找到 $TARGET_FILE"
    echo "----------------------------------------------------"
    echo "请确认你已从 GitHub Release 下载了对应架构的文件。"
    echo "当前目录文件列表："
    ls -p | grep -v /
    echo "----------------------------------------------------"
    exit 1
fi

# --- 1. 基础信息获取 ---
echo "🚀 开始安装 Workers Pro Editor (二进制版)..."
echo "--------------------------------"

read -p "请设置服务端口 [默认 $DEFAULT_PORT]: " input_port
PORT=${input_port:-$DEFAULT_PORT}

echo "--------------------------------"

# --- 2. 部署文件 ---
echo "📂 创建安装目录: $INSTALL_DIR"
# 如果正在运行，尝试停止
systemctl stop workers 2>/dev/null
rm -rf $INSTALL_DIR
mkdir -p $INSTALL_DIR

# [关键] 创建数据目录，确保 SQLite 可写入
mkdir -p $INSTALL_DIR/data
chmod 777 $INSTALL_DIR/data

echo "📦 安装二进制文件..."
cp "$BINARY_NAME" "$INSTALL_DIR/workers"
chmod +x "$INSTALL_DIR/workers"

# --- 3. 配置 Systemd 服务 ---
echo "⚙️ 配置 Systemd 服务..."
cat > /etc/systemd/system/workers.service <<EOF
[Unit]
Description=Workers Pro Editor Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
# 设置环境变量
Environment="PORT=$PORT"
Environment="DB_PATH=$INSTALL_DIR/data/database.sqlite"
ExecStart=$INSTALL_DIR/workers
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- 4. 自动放行防火墙端口 ---
echo "🛡️ 正在尝试开启防火墙端口: $PORT"
if command -v ufw >/dev/null 2>&1; then
    ufw allow $PORT/tcp >/dev/null 2>&1
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=$PORT/tcp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
else
    echo "⚠️ 未检测到 UFW 或 FirewallD，如果无法访问请手动检查防火墙设置。"
fi

# --- 5. 启动服务 ---
systemctl daemon-reload
systemctl enable workers
systemctl restart workers

# --- 6. 输出结果 ---
PUBLIC_IP=$(curl -s ifconfig.me || echo "你的服务器IP")
echo "--------------------------------"
echo "✅ 安装完成！(二进制版)"
echo "🌐 访问地址: http://$PUBLIC_IP:$PORT/"
echo "📂 数据目录: $INSTALL_DIR/data (SQLite数据库)"
echo "🔍 查看状态: systemctl status workers"
echo "--------------------------------"
