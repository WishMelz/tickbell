# TickBell 前端（Vue 3 + Vite + Quasar）

TickBell 提醒系统的管理后台前端，一套代码完整兼容 PC（≥ 1024px）与 H5 移动端（360px 起），内置浅色 / 深色 / 跟随系统三种主题。接口契约见 [`../docs/API.md`](../docs/API.md)。

## 快速开始（本地开发）

```bash
cd web
pnpm install
pnpm run dev
```

- 默认端口：`http://localhost:5173`
- Vite 会自动把 `/api/*` 代理到后端 `http://localhost:3000`（同源无 CORS，登录 Cookie 正常工作）。首次访问会自动进入初始化向导，手动设置管理密码与系统密钥。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm run dev` | 启动 Vite 开发服务器（:5173） |
| `pnpm run typecheck` | 运行 `vue-tsc --noEmit` 严格类型检查 |
| `pnpm test` | 运行 vitest 单元测试 |
| `pnpm run build` | 类型检查并构建生产静态产物到 `dist/` |

生产打包由后端 `server` 中的 `pnpm run build:all` 或 `deploy/Dockerfile` 统一执行，并将 `web/dist` 复制到 `server/public` 由 NestJS 同源托管。

## 渠道表单与卡片渲染约定

- **配置表单**：新建与编辑渠道表单由 `ChannelConfigForm.vue` 根据后端 `GET /api/channels/types` 返回的 `fields` 自动渲染（支持按 `group` 分组展示、多种控件及 `showWhen` 条件显隐）。接入新渠道时无需修改前端；如需特殊交互，可在 `src/components/channels/channelFormOverrides.ts` 中为对应 `type` 注册自定义组件。
- **卡片摘要与筛选**：渠道卡片直接遍历后端返回的 `ChannelView.summary` 展示关键摘要信息，并在存在多种渠道类型时自动展示类型筛选标签，不硬编码特定渠道字段。
