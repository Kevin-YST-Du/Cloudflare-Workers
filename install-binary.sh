#!/bin/bash
# 请替换为你的实际 GitHub 用户名和版本号
VERSION="4.7.0"
# DOWNLOAD_URL="https://github.com/你的用户名/workers/releases/download/v${VERSION}/workers-linux-x64"
INSTALL_DIR="/opt/workers"

echo ">>> 安装 Workers Pro Editor (二进制版)..."

mkdir -p $INSTALL_DIR/data
cd $INSTALL_DIR

if [ -f "workers-linux-x64" ]; then
    echo "发现本地二进制文件，正在使用..."
    mv workers-linux-x64 workers
else
    echo "请手动将构建好的 workers-linux-x64 放入此目录，或取消注释上方的 DOWNLOAD_URL 下载"
    exit 1
fi

chmod +x workers

# 创建 Systemd 服务
cat > /etc/systemd/system/workers.service <<EOF
[Unit]
Description=Workers Pro Editor Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/workers
Restart=always
# [修改点] 端口环境变量
Environment=PORT=21111

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable workers
systemctl start workers

echo ">>> 安装完成，服务运行在端口 21111"