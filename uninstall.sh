#!/bin/bash

# ================= 配置 =================
APP_NAME="workers"
INSTALL_DIR="/opt/workers"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
# =======================================

# 检查 Root 权限
if [ "$(id -u)" != "0" ]; then
    echo -e "${RED}错误：请使用 sudo 或 root 权限运行此脚本。${NC}"
    exit 1
fi

echo -e "${YELLOW}>>> 正在准备卸载 WorkerS Pro Editor...${NC}"

# ---------------------------------------------------------
# 1. 检测并处理 Docker 安装方式
# ---------------------------------------------------------
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    echo "检测到 Docker Compose 配置文件..."
    if command -v docker-compose &> /dev/null; then
        echo -e "${YELLOW}正在停止并移除 Docker 容器...${NC}"
        cd "$INSTALL_DIR"
        docker-compose down
    elif command -v docker &> /dev/null; then
        echo -e "${YELLOW}正在停止并移除 Docker 容器 (docker compose)...${NC}"
        cd "$INSTALL_DIR"
        docker compose down
    fi
    echo -e "${GREEN}Docker 服务已清理。${NC}"
fi

# ---------------------------------------------------------
# 2. 检测并处理 Systemd 安装方式 (源码版/二进制版)
# ---------------------------------------------------------
if [ -f "$SERVICE_FILE" ] || systemctl list-unit-files | grep -q "^${APP_NAME}.service"; then
    echo "检测到 Systemd 服务配置..."
    echo -e "${YELLOW}正在停止系统服务...${NC}"
    
    systemctl stop $APP_NAME
    systemctl disable $APP_NAME
    
    echo "移除服务文件..."
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl reset-failed
    
    echo -e "${GREEN}Systemd 服务已清理。${NC}"
else
    # 尝试暴力停止可能残留的进程 (针对二进制或Node进程)
    pkill -f "$INSTALL_DIR/src/server.js" 2>/dev/null
    pkill -f "$INSTALL_DIR/workers" 2>/dev/null
fi

# ---------------------------------------------------------
# 3. 文件清理与数据保留询问
# ---------------------------------------------------------
echo "------------------------------------------------"
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}警告：即将删除安装目录 $INSTALL_DIR${NC}"
    read -p "是否删除所有数据 (包括 Token 数据和 .env 配置)? [y/N] " confirm
    
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        echo "正在彻底删除文件..."
        rm -rf "$INSTALL_DIR"
        echo -e "${GREEN}✅ 所有文件已删除。${NC}"
    else
        echo "保留数据目录..."
        # 删除除 data 和 .env 以外的所有文件
        find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name "data" ! -name ".env" -exec rm -rf {} +
        echo -e "${GREEN}✅ 程序文件已卸载，保留了数据和配置文件。${NC}"
        echo -e "数据位置: $INSTALL_DIR/data"
    fi
else
    echo "安装目录不存在，跳过文件清理。"
fi

echo "------------------------------------------------"
echo -e "${GREEN}🎉 卸载完成！${NC}"