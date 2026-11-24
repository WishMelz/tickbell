import type { HttpPostFn } from '../ports/index';
import type { ChannelProvider, ChannelTypeDescriptor } from './channel-provider.interface';
import type { PrivateNetworkPolicy } from './http/url-policy';
import { BarkProvider } from './providers/bark.provider';
import { DingTalkProvider } from './providers/dingtalk.provider';
import { FeishuProvider } from './providers/feishu.provider';
import { ServerChanProvider } from './providers/serverchan.provider';
import { TelegramProvider } from './providers/telegram.provider';
import { WebhookProvider } from './providers/webhook.provider';
import { WeComProvider } from './providers/wecom.provider';

export class ChannelRegistry {
  private readonly providers = new Map<string, ChannelProvider>();

  constructor(providers: readonly ChannelProvider[]) {
    for (const provider of providers) {
      this.providers.set(provider.type, provider);
    }
  }

  get(type: string): ChannelProvider | undefined {
    return this.providers.get(type);
  }

  has(type: string): boolean {
    return this.providers.has(type);
  }

  listTypes(): ChannelTypeDescriptor[] {
    return [...this.providers.values()]
      .sort((a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999) || a.type.localeCompare(b.type))
      .map((provider) => ({
        type: provider.type,
        name: provider.meta.name,
        description: provider.meta.description,
        icon: provider.meta.icon,
        fields: [...provider.fields],
      }));
  }
}

export function createDefaultChannelRegistry(
  policy: PrivateNetworkPolicy,
  httpPost: HttpPostFn,
  extraProviders: readonly ChannelProvider[] = [],
): ChannelRegistry {
  return new ChannelRegistry([
    new BarkProvider(policy, httpPost),
    new TelegramProvider(policy, httpPost),
    new WeComProvider(policy, httpPost),
    new DingTalkProvider(policy, httpPost),
    new FeishuProvider(policy, httpPost),
    new ServerChanProvider(policy, httpPost),
    new WebhookProvider(policy, httpPost),
    ...extraProviders,
  ]);
}
