# TickBell Preview 演示版（源码部署说明）

本分支（`preview`）专为**公网在线演示环境**定制，默认开箱开启演示安全策略，无需额外配置即可直接从源码部署在测试服务器上。

## 内置演示策略与限制

| 项目 | 默认行为 | 可选环境变量 |
| :--- | :--- | :--- |
| **演示模式** | 默认开启（`true`） | `DEMO_MODE=true` |
| **预置演示密码** | `tickbell123`（登录页自动展示并支持「一键演示登录」） | `DEMO_PASSWORD=tickbell123` |
| **后台定时调度** | **强制关闭**，不会自动触发任何提醒 | 固定关闭 |
| **测试发送** | 允许渠道/提醒手动测试公网推送，**禁止内网 IP / 本机地址**（防 SSRF），每 IP 每分钟最多 10 次 | `DEMO_TEST_RATE_LIMIT=10` |
| **资源配额** | 提醒最多 **30** 条，通知渠道最多 **10** 个，单次提醒测试最多 **3** 个渠道 | `DEMO_MAX_REMINDERS=30`<br>`DEMO_MAX_CHANNELS=10`<br>`DEMO_MAX_TEST_CHANNELS=3` |
| **高危操作禁用** | 禁用修改管理密码、网络代理管理、全量备份导出/导入、本地自动备份与历史日志重发（后端统一返回 `403`） | 固定禁用 |
| **定时自动重置** | 每天 **03:00（Asia/Shanghai）** 自动清空并恢复预置示例渠道、提醒与日志 | `DEMO_RESET_CRON="0 3 * * *"`<br>`DEMO_RESET_TIMEZONE="Asia/Shanghai"` |

## 服务器源码部署（Linux）

环境要求：Node.js 22+、pnpm 10+。

```bash
git clone -b preview https://github.com/WishMelz/tickbell.git tickbell-preview
cd tickbell-preview
pnpm install
pnpm run build:all
```

### 方式一：直接启动（单进程同时托管前端与 API）

```bash
NODE_ENV=production PORT=3000 DB_PATH=./data/tickbell-demo.db node apps/node/dist/main.mjs
```

> 程序会自动识别 `web/dist` 与 `migrations/sqlite`，无需手动拷贝静态资源或配置 `STATIC_DIR`。

### 方式二：使用 PM2 守护运行（推荐）

```bash
pm2 start apps/node/dist/main.mjs \
  --name tickbell-preview \
  --cwd /path/to/tickbell-preview \
  --env production
```

或在启动前按需传入环境变量（例如更改端口、密码或反代配置）：

```bash
NODE_ENV=production \
PORT=3000 \
TRUST_PROXY=true \
COOKIE_SECURE=auto \
DEMO_PASSWORD=tickbell123 \
DB_PATH=/path/to/tickbell-preview/data/tickbell-demo.db \
pm2 start apps/node/dist/main.mjs --name tickbell-preview --update-env
```
