# 贡献指南（Contributing）

感谢你关注并考虑为 **TickBell 2.0** 贡献代码或文档！本文档介绍本地开发环境搭建、代码规范以及新增通知渠道插件的完整流程。

## 1. 开发环境准备

- **Node.js**：22+（推荐 22 LTS / 24 LTS）
- **包管理器**：`pnpm` 10+（根仓库为 pnpm Workspace）

安装全部工作区依赖：

```bash
pnpm install
```

### 本地调试

- **Cloudflare Workers + D1 模式**：
  ```bash
  pnpm run db:migrate:local
  pnpm run dev:cf
  ```
- **Node.js + SQLite 双进程模式**：
  ```bash
  # 终端 1：启动后端（http://localhost:3000）
  pnpm run dev:node

  # 终端 2：启动前端（http://localhost:5173，自动代理 /api 到 :3000）
  pnpm run dev:web
  ```

### 提交前检查

提交 PR 前请确认所有工作区检查通过：

```bash
pnpm run typecheck
pnpm run test
pnpm run build:all
pnpm exec wrangler deploy --dry-run
```

---

## 2. 如何贡献一个新的通知渠道

TickBell 的通知渠道采用**纯 Web Standards 插件化架构**（位于 `packages/core`），一套实现同时运行在 Cloudflare Workers 与 Node.js / Docker 两端。数据库无类型枚举限制，前端表单与渠道卡片摘要完全由后端元数据驱动。新增一个渠道通常只需要 **1 个 Provider 文件 + 1 行注册 + 1 份单元测试**。

### 步骤 1：创建 Provider 文件

在 [`packages/core/src/notifications/providers/`](./packages/core/src/notifications/providers/) 下创建 `<your-channel>.provider.ts`，实现 `ChannelProvider<YourConfig>` 接口（定义见 [`channel-provider.interface.ts`](./packages/core/src/notifications/channel-provider.interface.ts)）：

```ts
import { z } from 'zod';
import { ValidationError } from '../../common/errors';
import type { HttpPostFn } from '../../ports/index';
import {
  type ChannelField,
  type ChannelMeta,
  type ChannelProvider,
  type MaskedChannelConfig,
  type NotificationMessage,
  type NotificationResult,
  type SendOptions,
} from '../channel-provider.interface';
import { resultFromError, resultFromHttpResponse } from '../http/http-helpers';
import { formatTimeLine, hostSummaryFromUrl } from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const exampleConfigSchema = z.strictObject({
  endpointUrl: z.string().min(1),
  token: z.string(),
});

export type ExampleConfig = z.infer<typeof exampleConfigSchema>;

export class ExampleProvider implements ChannelProvider<ExampleConfig> {
  readonly type = 'example';

  readonly meta: ChannelMeta = {
    type: 'example',
    name: '示例渠道',
    description: '简短描述该渠道的适用平台与能力',
    icon: 'notifications', // 需在 web/src/icons.ts 的 channelIconMap 中存在
    order: 10,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'endpointUrl',
      label: '接口地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      placeholder: 'https://push.example.com/send',
    },
    {
      key: 'token',
      label: 'Token',
      group: '连接与鉴权',
      control: 'text',
      required: true,
      secret: false,
    },
  ];

  readonly configSchema = exampleConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: ExampleConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): ExampleConfig | null {
    // 1. 校验必填字段与格式，失败时抛出中文 ValidationError
    // 2. 外部 URL 必须使用 parsePublicHttpUrl(..., policy) 校验协议与地址策略
    // 3. 字段为 undefined 沿用 existing，为 null 或空字符串表示清空
    ...
  }

  isConfigured(config: ExampleConfig | null): boolean {
    return Boolean(config?.endpointUrl && config?.token);
  }

  maskConfig(config: ExampleConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    return {
      config: { ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary: [{ label: '地址', value: hostSummaryFromUrl(config.endpointUrl) }],
    };
  }

  async send(
    message: NotificationMessage,
    config: ExampleConfig,
    options?: SendOptions,
  ): Promise<NotificationResult> {
    try {
      const response = await this.httpPost({
        url: config.endpointUrl,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: message.title,
          body: [message.content, formatTimeLine(message)].join('\n\n'),
        }),
        timeoutMs: 15_000,
        policy: this.policy,
        proxy: options?.proxy,
      });
      // 可通过 evaluate 回调校验平台业务状态码，区分 retryable / permanent / unknown
      return resultFromHttpResponse(response);
    } catch (error) {
      return resultFromError(error);
    }
  }
}
```

### 步骤 2：在注册表中注册 Provider

在 [`packages/core/src/notifications/channel-registry.ts`](./packages/core/src/notifications/channel-registry.ts) 的 `createDefaultChannelRegistry()` 中实例化并注册你的 Provider，并在 [`packages/core/src/index.ts`](./packages/core/src/index.ts) 导出。

### 步骤 3：编写单元测试

在 [`packages/core/test/core.test.ts`](./packages/core/test/core.test.ts) 中补充测试，至少覆盖：
- `mergeConfig` 的正常与异常输入校验；
- `maskConfig` 的摘要输出；
- `send` 的请求地址、请求头/签名、载荷构造与长度截断；
- 错误分类：`retryable`（频控/瞬态错误）、`permanent`（鉴权/参数错误）、`unknown`（服务端 500/超时）；
- 日志/错误信息不泄露敏感凭据。

---

## 3. 安全与编码约定

- **保持 `packages/core` 纯 Web Standards**：禁止在 `packages/core` 中引入 `node:*`、`Buffer`、`process`、`better-sqlite3` 或 `undici`，所有签名/哈希统一使用 [`packages/core/src/crypto/index.ts`](./packages/core/src/crypto/index.ts) 的 Web Crypto 封装，确保 Cloudflare Workers 与 Node.js 行为一致。
- **日志脱敏**：严禁在日志或 `error` / `responseSummary` 中输出明文 Token、SendKey、Webhook `key` / `access_token` 或 HMAC 密钥；通过共享 `HttpPostFn` 与 `sanitizeSensitiveText` 可自动脱敏常见敏感参数。
- **错误分类准确**：平台频控错误码或 HTTP `429/502/503/504` 应返回 `errorClass: 'retryable'`，以接入调度器 `1 → 5 → 15` 分钟退避重试；鉴权/签名/参数错误返回 `permanent`，避免无效重试。
- **表单分组规范**：前端配置表单按 `field.group` 自动分段，建议统一使用「`连接与鉴权`」和「`通知配置`」两个分组名。
- **前端图标**：`meta.icon` 需选用 [`web/src/icons.ts`](./web/src/icons.ts) 中 `channelIconMap` 已映射的图标名；如需新增图标，同步在该文件中按需引入对应图标即可。
- **保持轻量**：不引入 Redis、外部消息队列或重型中间件。
