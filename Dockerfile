# 基础镜像可用 --build-arg NODE_IMAGE=<国内镜像地址> 覆盖
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8580 \
    DATA_DIR=/app/data

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund \
    && npm cache clean --force

COPY src ./src
COPY public ./public

VOLUME ["/app/data"]
EXPOSE 8580

HEALTHCHECK --interval=60s --timeout=8s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8580)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
