FROM node:18-alpine

WORKDIR /app

# 安装编译 SQLite 必须的工具
RUN apk add --no-cache python3 make g++

COPY package.json .
RUN npm install --production

COPY src/ ./src/

# 设置环境变量
ENV PORT=21020
ENV DB_PATH=/app/data/database.sqlite

# 声明挂载卷
VOLUME /app/data

EXPOSE 21020

# 启动程序
CMD ["node", "src/server.js"]
