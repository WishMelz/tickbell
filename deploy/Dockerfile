# TickBell 2.0 多阶段镜像：单容器托管 Hono API + Quasar SPA（pnpm workspace 构建）
# 构建上下文为 TickBell 项目根目录：
#   docker build -f deploy/Dockerfile -t tickbell:latest .
# 国内或离线环境可通过 --build-arg NODE_IMAGE=... 指定镜像源或本地已缓存的基础镜像

ARG NODE_IMAGE=node:24-slim

# ---------- 1. 构建前端（与 CPU 架构无关，宿主机原生构建加速多架构打包） ----------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web-build
RUN npm install -g pnpm@12
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/node/package.json ./apps/node/
COPY apps/worker/package.json ./apps/worker/
COPY web/package.json ./web/
RUN pnpm --filter tickbell-web install --frozen-lockfile
COPY web/ ./web/
RUN pnpm --filter tickbell-web build

# ---------- 2. 构建 Node 运行时（esbuild 打包 core + node 入口，编译 better-sqlite3） ----------
FROM ${NODE_IMAGE} AS node-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/node/package.json ./apps/node/
COPY apps/worker/package.json ./apps/worker/
COPY web/package.json ./web/
RUN pnpm --filter tickbell-node... install --frozen-lockfile
COPY packages/core/ ./packages/core/
COPY apps/node/ ./apps/node/
RUN pnpm --filter tickbell-node build \
    && node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.scripts.deploy;fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
    && pnpm --filter tickbell-node deploy --prod --legacy /app \
    && node -e "require('/app/node_modules/better-sqlite3')"

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
    MIGRATIONS_DIR=/app/migrations/sqlite \
    COOKIE_SECURE=auto \
    TRUST_PROXY=true \
    ALLOW_PRIVATE_URLS=true

COPY --from=node-build /app/package.json ./
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /workspace/apps/node/dist ./dist
COPY migrations/sqlite ./migrations/sqlite
COPY --from=web-build /workspace/web/dist ./public

RUN mkdir -p /data/backups && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.mjs"]
