# 使用轻量级 Node 镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装构建依赖 (better-sqlite3 需要 python 和 g++)
RUN apk add --no-cache python3 make g++

# 复制依赖配置
COPY package.json .

# 安装依赖
RUN npm install --production

# 复制源代码
COPY server.js .

# 创建数据卷挂载点
VOLUME /app/data

# --- 修改开始 ---
# 设置环境变量默认端口
ENV PORT=21020
ENV DB_PATH=/app/data/database.sqlite

# 暴露 21020 端口
EXPOSE 21020
# --- 修改结束 ---

# 启动命令
CMD ["node", "server.js"]
