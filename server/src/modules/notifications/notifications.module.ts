import { Global, Module } from '@nestjs/common';
import { CHANNEL_PROVIDERS } from './channel-provider.interface';
import { ChannelRegistry } from './channel-registry.service';
import { BarkProvider } from './providers/bark.provider';
import { DingTalkProvider } from './providers/dingtalk.provider';
import { FeishuProvider } from './providers/feishu.provider';
import { ServerChanProvider } from './providers/serverchan.provider';
import { TelegramProvider } from './providers/telegram.provider';
import { WebhookProvider } from './providers/webhook.provider';
import { WeComProvider } from './providers/wecom.provider';

const ALL_PROVIDERS = [
  BarkProvider,
  TelegramProvider,
  WeComProvider,
  DingTalkProvider,
  FeishuProvider,
  ServerChanProvider,
  WebhookProvider,
];

@Global()
@Module({
  providers: [
    ...ALL_PROVIDERS,
    {
      provide: CHANNEL_PROVIDERS,
      inject: ALL_PROVIDERS,
      useFactory: (
        bark: BarkProvider,
        telegram: TelegramProvider,
        wecom: WeComProvider,
        dingtalk: DingTalkProvider,
        feishu: FeishuProvider,
        serverchan: ServerChanProvider,
        webhook: WebhookProvider,
      ) => [bark, telegram, wecom, dingtalk, feishu, serverchan, webhook],
    },
    ChannelRegistry,
  ],
  exports: [ChannelRegistry, CHANNEL_PROVIDERS, ...ALL_PROVIDERS],
})
export class NotificationsModule {}
