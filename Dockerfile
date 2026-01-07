# Build Stage
FROM node:20-alpine AS base

WORKDIR /app

# 复制依赖配置
COPY package.json ./

# 复制源码
COPY src ./src

# 创建数据目录
RUN mkdir -p /app/data

# [修改点] 暴露端口 21111
EXPOSE 21111

# 启动命令
CMD ["node", "src/server.js"]