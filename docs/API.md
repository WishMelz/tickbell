# TickBell API 契约

> 本文件是 `server/`（NestJS）和 `web/`（Vue + Quasar）之间的**唯一接口契约**。改接口时先改本文件。
> 设计背景见 [重构方案.md](./重构方案.md)：3.2 调度、3.3 表结构、3.4 接口清单、3.6 渠道扩展。

## 0. 通用约定

| 项 | 约定 |
| --- | --- |
| 前缀 | 所有接口都在 `/api` 下（Nest `setGlobalPrefix('api')`） |
| 格式 | 请求和响应都是 JSON（UTF-8） |
| 成功 | HTTP 2xx，响应体 `{ "data": <payload> }`；没有返回内容时为 `{ "data": null }` |
| 失败 | HTTP 4xx/5xx，响应体 `{ "error": "<中文可读信息>" }` |
| 状态码 | 400 校验失败 · 401 未登录或会话失效 · 404 资源不存在 · 409 冲突（例如渠道被引用） · 413 请求体过大 · 429 限流 · 500 服务器错误 · 503 未配置管理密码 |
| 缓存 | 所有 `/api` 响应都带 `Cache-Control: no-store` |
| 鉴权 | Cookie `tickbell_session`：HttpOnly、SameSite=Strict、Path=/、有效期 7 天；`Secure` 默认自动识别（HTTPS 请求自动开启，也可通过 `COOKIE_SECURE` 手动指定）。除了标注 **公开** 的接口，其他都要登录，否则返回 401；系统未完成首次初始化时返回 503 |
| 时间 | 绝对时间一律用 ISO 8601 UTC 字符串（例如 `2026-11-23T02:00:00.000Z`）。本地时间用 `YYYY-MM-DDTHH:mm`，**不带时区**，按提醒的生效时区解释 |
| ID | UUID v4 字符串 |

## 1. 认证 Auth

### `GET /api/auth/status` — 公开
```json
{ "data": { "initialized": true, "configured": true, "authenticated": false, "configurationIssue": null } }
```
- `initialized`：`false` 表示首次启动尚未初始化，前端应展示「首次设置密码与密钥」界面；`true` 表示可直接登录。
- `configured`：与 `initialized` 保持一致（兼容字段）。
- `configurationIssue`：未初始化时为 `"missing"`，否则为 `null`。

### `POST /api/auth/setup` — 公开，限流：每个 IP 每 60 秒 5 次
首次启动初始化管理员密码与系统密钥（持久化到 SQLite `settings`，后续启动无需环境变量）。
请求体：`{ "password": "...", "secret": "...", "globalTimezone"?: "Asia/Shanghai" }`
- `password`：至少 6 个字符，服务端以随机盐 `scrypt` 哈希存库。
- `secret`：至少 16 个字符（前端支持手动填写或一键随机生成），用作会话签名密钥。
- `globalTimezone`：可选，默认识别浏览器时区。
成功返回 `{ "data": { "authenticated": true } }` 并自动设置登录 Cookie；若系统已完成初始化，返回 `409`。

### `POST /api/auth/login` — 公开，限流：每个 IP 每 60 秒 5 次
请求体 `{ "password": "..." }` → 成功返回 `{ "data": { "authenticated": true } }`，并设置 Cookie。
失败：密码为空返回 400，密码错误返回 401，超出限流返回 429（带 `Retry-After: 60`），未初始化返回 503。

### `POST /api/auth/change-password` — 需登录，限流：每个 IP 每 60 秒 5 次
请求体 `{ "currentPassword": "...", "newPassword": "..." }` → 校验当前密码，更新密码哈希、轮换 `session_generation`（使其他设备会话失效）并为当前响应签发新 Cookie，返回 `{ "data": { "changed": true } }`。

### `POST /api/auth/logout` — 公开
清除 Cookie，返回 `{ "data": null }`。

## 2. 设置 Settings

### `GET /api/settings` → `{ "data": { "globalTimezone": "Asia/Shanghai" } }`
### `PUT /api/settings`
请求体 `{ "globalTimezone": "Asia/Shanghai" }`（IANA 时区名），返回同样的结构。
规则：跟随全局时区的提醒（`timezone = null`）保持原来的**本地日期和钟点**不变，重新换算 `starts_at` 和 `next_run_at`，在同一个事务里完成。

## 3. 通知渠道 Channels

### `GET /api/channels/types` → 已注册的渠道类型（按 `order` 升序，内置 7 种）

内置渠道类型：`bark`（Bark）、`telegram`（Telegram Bot）、`wecom`（企业微信机器人）、`dingtalk`（钉钉机器人）、`feishu`（飞书机器人）、`serverchan`（Server酱）、`webhook`（通用 Webhook）。每个类型返回统一的元数据结构（以下以 `bark` 为例）：
```json
{ "data": [ {
  "type": "bark", "name": "Bark", "description": "iOS 推送（支持自建 Bark 服务或官方服务）", "icon": "notifications",
  "fields": [
    { "key": "serverUrl", "label": "Bark 服务器地址", "group": "连接与鉴权", "control": "url", "required": true, "secret": false, "default": "https://api.day.app", "help": "支持自建内网或公网地址，例如 http://192.168.1.10:8080 或 https://bark.example.com" },
    { "key": "deviceKey", "label": "设备密钥（Device Key）", "group": "连接与鉴权", "control": "text", "required": true, "secret": false },
    { "key": "group", "label": "通知分组", "group": "通知配置", "control": "text", "required": false, "secret": false, "default": "TickBell" },
    { "key": "level", "label": "通知级别", "group": "通知配置", "control": "select", "required": false, "secret": false, "default": "active",
      "options": [ {"label":"普通","value":"active"}, {"label":"静默","value":"passive"}, {"label":"时效性","value":"timeSensitive"}, {"label":"重要警告","value":"critical"} ] },
    { "key": "sound", "label": "铃声", "group": "通知配置", "control": "text", "required": false, "secret": false, "showWhen": { "field": "level", "notIn": ["passive"] } },
    { "key": "call", "label": "重复响铃 30 秒", "group": "通知配置", "control": "switch", "required": false, "secret": false, "default": false, "showWhen": { "field": "level", "notIn": ["passive"] } },
    { "key": "volume", "label": "重要警告音量", "group": "通知配置", "control": "number", "required": false, "secret": false, "default": 5, "min": 0, "max": 10, "showWhen": { "field": "level", "in": ["critical"] } },
    { "key": "icon", "label": "自定义图标 URL", "group": "通知配置", "control": "url", "required": false, "secret": false },
    { "key": "isArchive", "label": "保存到 Bark 历史记录", "group": "通知配置", "control": "switch", "required": false, "secret": false, "default": true }
  ]
} ] }
```
`control` 可取：`text | password | url | select | switch | number | textarea`。`group` 可选，用于前端表单分组展示（内置渠道统一分为 `连接与鉴权` / `通知配置`）。`showWhen` 可以省略，形如 `{ field, in?: [], notIn?: [] }`。各内置渠道完整字段说明见 [通知渠道扩展计划.md](./通知渠道扩展计划.md)。

### ChannelView（渠道对象）
```ts
{
  id: string; name: string; type: string; enabled: boolean;
  supported: boolean;               // type 已注册时为 true；导入未注册的第三方类型时为 false
  config: Record<string, unknown> | null; // 渠道配置对象（内置渠道均明文回填，方便查看与编辑）
  secretsSet: string[];             // 若自定义渠道定义了 secret 字段，列出已设置的字段名
  summary: { label: string; value: string }[]; // 后端生成的卡片关键摘要行（已脱敏，如目标主机/Chat ID/签名状态）
  configured: boolean;              // 配置完整、能用来发送
  createdAt: string; updatedAt: string;
}
```

### `GET /api/channels` → `ChannelView[]`（按创建时间升序）
### `POST /api/channels` → 201 `ChannelView`
请求体 `{ "name": "我的 iPhone", "type": "bark", "enabled": true, "config": { "serverUrl": "...", "deviceKey": "...", "level": "active" } }`
规则：`name` 1–80 个字符；`type` 必须已注册；启用时配置必须完整；默认允许自建内网与公网 `http(s)` 地址（可通过 `ALLOW_PRIVATE_URLS=false` 开启严格公网限制）。
### `PUT /api/channels/:id` → `ChannelView`
请求体 `{ "name", "enabled", "config" }`（不能改 type）。所有内置渠道的配置与凭据均按明文返回和回填，编辑时可直接修改；`supported=false` 的渠道只能改名或停用。
### `DELETE /api/channels/:id` → `null`
被提醒或投递记录引用时返回 409，提示「可以改为停用」。
### `POST /api/channels/:id/test` → 永远返回 200
```json
{ "data": { "ok": false, "httpStatus": 400, "responseSummary": "...", "error": "渠道发送失败: ..." } }
```
（服务端日志与 `error` / `responseSummary` 会自动对 URL 中的 `bot<token>`、`key=`、`access_token=`、`sendkey` 等敏感凭据做脱敏处理。）

## 4. 提醒 Reminders

### ReminderView（提醒对象）
```ts
{
  id: string; title: string; content: string; contentHtml: string | null;
  category: string; tags: string[];
  timezone: string;              // 生效时区
  usesGlobalTimezone: boolean;   // true 表示 DB 中 timezone 为 NULL
  scheduledLocal: string;        // 首次计划时间（本地，YYYY-MM-DDTHH:mm）
  startsAt: string;              // ISO UTC
  isRepeating: boolean; repeatEvery: number | null; repeatUnit: 'hour' | 'day' | 'month' | 'year' | null;
  channelIds: string[];
  enabled: boolean; completed: boolean;
  nextRunAt: string;             // ISO UTC
  nextRunLocal: string;          // 本地，YYYY-MM-DDTHH:mm
  createdAt: string; updatedAt: string;
}
```

### ReminderInput（创建 / 更新 / 测试发送的请求体）
```ts
{
  title: string;                 // 1–120 个字符（去掉首尾空格后）
  content?: string;              // 纯文本，≤ 4000；如果提供了 contentHtml，就以 HTML 转出的纯文本为准
  contentHtml?: string | null;   // ≤ 64000，服务端按白名单过滤（p br strong b em i u s del blockquote ul ol li a[href]）
  category?: string;             // ≤ 80
  tags?: string[];               // ≤ 10 个，每个 ≤ 30，去重，去掉空值
  scheduledLocal: string;        // YYYY-MM-DDTHH:mm
  timezone: string | null;       // null 表示跟随全局时区
  isRepeating: boolean;
  repeatEvery: number | null;    // 重复提醒时必须是 1–9999 的整数
  repeatUnit: 'hour' | 'day' | 'month' | 'year' | null;
  channelIds: string[];          // 至少 1 个，必须都存在
  enabled?: boolean;             // 只在创建时生效，默认 true
}
```

### `GET /api/reminders?search=&category=&tag=&status=`
返回所有未删除的提醒（`ReminderView[]`，按 `nextRunAt` 升序，最多 `MAX_REMINDERS` 条），由前端分页。
`status` 可取 `active`（启用且未完成）、`paused`（未启用且未完成）、`completed`；不传表示全部。`search` 用 LIKE 匹配标题、正文、分类、标签。
### `GET /api/reminders/:id` → `ReminderView`
### `POST /api/reminders` → 201 `ReminderView`
数量达到 `MAX_REMINDERS` 时返回 400：「提醒数量已达到 N 条上限」。
### `PUT /api/reminders/:id` → `ReminderView`
计划变更（`scheduledLocal`、`timezone`、重复规则任一项变化）时：`next_run_at` 重置为新的 `starts_at`；已完成的提醒恢复成启用、未完成；`schedule_version` 加 1。
### `DELETE /api/reminders/:id` → `null`（软删除，同时删掉渠道关联）
### `POST /api/reminders/:id/enable` → `ReminderView`
- 已完成的提醒：返回 400「已完成的提醒需要编辑时间后重新安排」。
- 重复提醒且 `next_run_at <= now`：先跳到下一个**未来**的时间点再启用（不补发）。
- 单次提醒且时间已过：返回 400「提醒时间已过，请先修改时间」。
### `POST /api/reminders/:id/disable` → `ReminderView`
### `POST /api/reminders/batch`
请求体 `{ "ids": string[1..500], "action": "enable" | "disable" | "delete" | "channels", "channelIds"?: string[] }` → `{ "updated": n, "skipped": m }`
`channels` 表示**替换**渠道，必须提供至少一个 `channelIds`。整批在一个事务里完成。`enable` 的规则和单条启用相同，不符合条件的计入 `skipped`。
### `POST /api/reminders/test`
请求体是 `ReminderInput`（不保存）→ `[{ "channelId", "channelName", "ok", "error" }]`。
关闭、未配置或类型暂不支持的渠道不会发送，直接返回 `ok:false` 和原因。

## 5. 投递日志 Deliveries

### DeliveryView（投递对象）
```ts
{
  id: string; eventId: string;
  reminderId: string; reminderTitle: string;
  scheduledAt: string;           // 本次触发对应的计划时间（ISO UTC）
  channelId: string; channelName: string; channelType: string;
  status: 'pending' | 'sent' | 'failed' | 'retrying' | 'skipped';
  attempts: number; nextRetryAt: string | null;
  httpStatus: number | null; error: string | null; responseSummary: string | null;
  sentAt: string | null; createdAt: string; updatedAt: string;
}
```
### `GET /api/deliveries?reminderId=&channelId=&status=&page=1&pageSize=20`
→ `{ "items": DeliveryView[], "total": n, "page": 1, "pageSize": 20 }`，按 `createdAt` 降序；`pageSize` 范围 1–100。
### `POST /api/deliveries/:id/retry` → `DeliveryView`
只有 `failed` 状态能手动重发：复用同一个 `eventId`，`attempts` 加 1，结果直接写回这条记录。其他状态返回 409。

## 6. 系统 System

### `GET /api/health` — 公开
正常时返回 200 `{ "data": { "status": "ok", "db": "ok", "scheduler": { "enabled": true, "lastTickAt": "...", "healthy": true } } }`。
数据库不可用，或调度器已启用但超过 120 秒没有心跳时，返回 503，`status` 为 `"degraded"`。
### `GET /api/system/status`
```ts
{
  version: string; startedAt: string; uptimeSeconds: number; nodeVersion: string;
  scheduler: { enabled: boolean; paused: boolean; intervalMs: number; lastTickAt: string | null; lastTickDurationMs: number | null };
  counts: { reminders: number; activeReminders: number; channels: number; retryingDeliveries: number };
  limits: { maxReminders: number; missedGraceMinutes: number; deliveryRetentionDays: number };
  backup: { lastBackupAt: string | null; lastBackupFile: string | null; keepDays: number };
}
```

## 7. 全量备份 Backup

> 导出默认生成**可读明文 JSON**（`tickbell-full-backup` v2），无需设置备份密码。导入恢复时自动识别明文文件（同时兼容 `tips-full-backup` v1/v2 与旧版浏览器端加密备份 `tips-encrypted-backup` v1）。

### 明文格式
- **导入**接受 `format: "tickbell-full-backup"`（`version: 2`）以及兼容格式 `format: "tips-full-backup"`（`version: 1 | 2`）。
- **导出**为 `format: "tickbell-full-backup", version: 2`。

v2 和 v1 的差异：
- `deliveries[]` 多一个 `next_retry_at`，`status` 增加 `retrying` / `skipped` 两种取值。
- `channels[]` 去掉 `legacy_encrypted_config`。
- 其余字段（`settings`、`reminders`、`channels`、`reminderChannels`、`deliveries`、`receipts`）和 v1 相同，字段名用 snake_case，时间是毫秒时间戳。

### `POST /api/backup/export` — 限流同登录
请求体 `{ "password": "<管理密码>" }` → 明文备份对象。密码错误返回 400。
### `POST /api/backup/preview`
请求体 `{ "backup": {...} }`，返回：
```ts
{ reminders, activeReminders, deletedReminders, channels, unsupportedChannels, deliveries, pendingDeliveries,
  globalTimezone, exportedAt, sourceVersion: 1 | 2,
  remindersWithoutUsableChannel: { id: string; title: string }[] }
```
### `POST /api/backup/restore` — 限流同登录
请求体 `{ "backup": {...}, "password": "...", "confirmation": "RESTORE" }` → `{ "restored": true }`。
规则：
- 恢复期间暂停调度器，所有写入在一个事务里完成，失败整体回滚。
- 恢复后所有提醒都是**暂停**状态；`pending` / `retrying` 的投递改为 `failed`，并注明「恢复时状态未知」。
- 去重凭据（receipts）和目标库已有的凭据合并。
- 渠道类型没有注册的，保留原配置，但强制停用。
- 会话版本号更换，所有旧登录失效，同时清除当前请求的 Cookie；目标环境已设置的管理密码哈希与系统密钥会被保留，不会被备份覆盖（导出时也不包含这些认证信息）。
- 备份明文超过 32 MB 返回 413。
