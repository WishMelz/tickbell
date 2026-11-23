# TickBell 多阶段镜像：单容器托管 NestJS API + Quasar SPA（pnpm 构建）
# 构建上下文为 TickBell 项目根目录：
#   docker build -f deploy/Dockerfile -t tickbell:latest .
# 国内或离线环境可通过 --build-arg NODE_IMAGE=... 指定镜像源或本地已缓存的基础镜像

ARG NODE_IMAGE=node:24-slim

# ---------- 1. 构建前端（静态产物与 CPU 架构无关，使用宿主机原生架构构建以加速多架构打包） ----------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web-build
RUN npm install -g pnpm@12
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

# ---------- 2. 构建后端 ----------
FROM ${NODE_IMAGE} AS server-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/ ./
RUN pnpm run build && pnpm prune --prod

# ---------- 3. 生产运行时（零必填密钥，首次启动在网页设置密码和密钥） ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/tickbell.db \
    BACKUP_DIR=/data/backups \
    STATIC_DIR=/app/public \
    TRUST_PROXY=1 \
    COOKIE_SECURE=auto \
    ALLOW_PRIVATE_URLS=true

COPY --from=server-build /app/server/package.json ./
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/migrations ./migrations
COPY --from=web-build /app/web/dist ./public

RUN mkdir -p /data/backups && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
