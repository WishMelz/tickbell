# TickBell 极简部署与运维指南

## 1. 首次部署（单容器 · 单端口 · 零必填密钥）

管理密码和系统密钥**不需要**写进环境变量：启动容器后首次打开网页手动设置一次即可，数据会持久化在 `deploy/data/tickbell.db` 中，后续重启、升级都不需要再配置。

宿主机仅暴露一个端口（默认 `0.0.0.0:3000:3000`），同一个容器同时托管前端页面与 `/api` 接口：

```bash
cd tickbell/deploy
# Linux 宿主机首次启动前创建数据目录并授权给容器内 node 用户（uid=1000）
mkdir -p ./data && chown -R 1000:1000 ./data

# 如已有本机镜像可直接 docker compose up -d；首次从源码构建加 --build
docker compose up -d --build
```

> - 修改端口：在 `deploy/.env` 中写入 `PORT=8088`（或直接修改 `docker-compose.yml` 中的 `ports` 左侧）。
> - 如需挂在已有 Nginx / 宝塔 / 1Panel 反向代理后面：将 `ports` 改为 `"127.0.0.1:3000:3000"`，反代转发到 `http://127.0.0.1:3000` 并传递 `X-Forwarded-For` 与 `X-Forwarded-Proto`（`COOKIE_SECURE=auto` 会自动识别 HTTPS）。

### 首次初始化

部署完成后，在浏览器打开站点：
1. 页面自动进入「首次启动初始化」：输入**管理密码**（至少 6 位）和**系统密钥**（可手动输入或一键随机生成），选择默认全局时区。
2. 点击「完成初始化并进入系统」即自动登录。后续随时可在「系统设置 → 修改管理密码」中改密。

## 2. 配置通知渠道

系统默认允许访问自建的内网或公网通知地址（`ALLOW_PRIVATE_URLS=true`），进入「通知渠道 → 新建渠道」可按需选择以下 7 种内置渠道，配置完成后点击「测试」即可实时验证推送效果：

- **Bark**：支持官方或自建内网/公网 `bark-server`（如 `http://192.168.1.10:8080`），支持通知分组、级别、铃声、重复响铃、重要警告音量、自定义图标与历史记录。
- **Telegram Bot**：支持官方 `api.telegram.org` 或自建 Bot API 代理、超级群组 Topic 话题、HTML 格式、静默推送与防转发。
- **企业微信机器人**：支持 `markdown` / `markdown_v2` / `text` 及 `@成员` / `@所有人`。
- **钉钉机器人**：支持加签密钥（HMAC-SHA256）与自定义关键词、`markdown` / `text` 及 `@成员` / `@所有人`。
- **飞书机器人**：支持飞书/Lark 签名校验与关键词、交互式富文本卡片与 `@所有人`。
- **Server酱**：自动识别 Server酱³（`sctp{uid}t...`）与 Server酱 Turbo（`SCT...`），支持自定义推送通道与标签。
- **通用 Webhook**：支持 `POST` / `PUT`、标准 HMAC-SHA256 签名请求头、自定义请求头与 JSON 模板。

> 如需严格禁止访问内网地址，可在 `.env` 中加 `ALLOW_PRIVATE_URLS=false`（并可选用 `ALLOWED_PRIVATE_HOSTS` 放行指定主机/网段）。

## 3. 全量备份导入与跨实例迁移

1. 在原实例「系统设置 → 导出全量备份」导出可读明文 JSON（`tickbell-full-backup`）。
2. 在新实例完成首次初始化并登录后，进入「系统设置 → 导入并覆盖恢复」，导入备份文件（恢复不会覆盖新实例已设置的管理密码和密钥）。
3. 停用旧实例的定时任务或服务，防止重复推送。
4. 在新实例中检查渠道配置并启用提醒。

## 4. SQLite 备份与恢复

- 应用每天 UTC 03:00 自动执行 `VACUUM INTO` 生成在线一致性备份至 `deploy/data/backups/tickbell-YYYYMMDD-HHmmss.db`，默认保留 14 天。
- **切勿在运行中直接 `cp data/tickbell.db`**（WAL 模式会漏掉 `-wal` 数据）。

恢复步骤：

```bash
cd tickbell/deploy
docker compose stop tickbell
cp data/backups/tickbell-YYYYMMDD-HHmmss.db data/tickbell.db
rm -f data/tickbell.db-wal data/tickbell.db-shm
docker compose start tickbell
```

## 5. 升级

```bash
cd tickbell
git pull
cd deploy
docker compose up -d --build
```
