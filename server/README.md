# TickBell 后端（NestJS + SQLite）

TickBell 提醒系统的单机自部署后端，基于 NestJS 11（Express 平台）和 SQLite（`better-sqlite3`，WAL 模式）。接口契约见 [`../docs/API.md`](../docs/API.md)，架构设计见 [`../docs/重构方案.md`](../docs/重构方案.md)。

## 环境要求

- Node.js 22+（生产镜像使用 Node.js 24 LTS）
- pnpm 10+

## 快速开始（本地开发）

```bash
cd server
pnpm install
pnpm run start:dev
```

- 端口：`http://localhost:3000`
- 数据库：`server/data/dev.db`（启动时自动建表和迁移）
- 密码与密钥：**无需配置环境变量**，首次打开前端页面（`http://localhost:5173`）手动设置一次即可持久化在数据库中。

## 内置通知渠道（7 种）

所有渠道均实现统一的 `ChannelProvider` 插件接口，位于 `src/modules/notifications/providers/`：

| 类型标识 | 渠道名称 | Provider 文件 |
| --- | --- | --- |
| `bark` | Bark | `bark.provider.ts` |
| `telegram` | Telegram Bot | `telegram.provider.ts` |
| `wecom` | 企业微信机器人 | `wecom.provider.ts` |
| `dingtalk` | 钉钉机器人 | `dingtalk.provider.ts` |
| `feishu` | 飞书机器人 | `feishu.provider.ts` |
| `serverchan` | Server酱 | `serverchan.provider.ts` |
| `webhook` | 通用 Webhook | `webhook.provider.ts` |

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm run start:dev` | 开发模式（监听源码热重启） |
| `pnpm run typecheck` | TypeScript 类型检查 |
| `pnpm test` | 运行 vitest 单元测试与集成测试 |
| `pnpm run build` | 编译后端到 `dist/` |
| `pnpm run build:all` | 先构建 `../web` 并复制到 `public/`，再构建后端（生产单进程形态） |
| `pnpm run start:prod` | 运行生产编译产物 `node dist/main.js`（存在 `public/index.html` 时自动托管前端） |

## 环境变量（全部可选）

正常自部署无需配置密钥环境变量；常用微调项见 [`.env.example`](./.env.example)：
- `PORT`（默认 `3000`）、`DB_PATH`（默认 `./data/tickbell.db`）
- `COOKIE_SECURE`（默认 `auto`，根据 HTTPS 请求自动开启）
- `ALLOW_PRIVATE_URLS`（默认 `true`，允许推送到自建内网 / Docker / 本机通知地址；设为 `false` 可启用严格公网 SSRF 校验并配合 `ALLOWED_PRIVATE_HOSTS`）
- `MAX_REMINDERS`（默认 `500`）、`MISSED_GRACE_MINUTES`（默认 `60`）、`DELIVERY_RETENTION_DAYS`（默认 `90`）

## 新增通知渠道

完整插件开发规范与代码模板见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。
