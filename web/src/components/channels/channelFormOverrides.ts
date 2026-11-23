import type { Component } from 'vue';

/**
 * 渠道表单扩展覆盖点（见 docs/重构方案.md 3.6）。
 * 默认所有渠道均由 ChannelConfigForm 根据后端 GET /api/channels/types 的 fields 描述自动渲染；
 * 若某个未来渠道需要特殊交互（如扫码绑定），在此注册 `type -> 自定义表单组件` 即可覆盖。
 */
export const channelFormOverrides: Record<string, Component> = {};
