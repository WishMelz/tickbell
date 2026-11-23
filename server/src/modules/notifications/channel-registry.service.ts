import { Inject, Injectable } from '@nestjs/common';
import {
  CHANNEL_PROVIDERS,
  type ChannelProvider,
  type ChannelTypeDescriptor,
} from './channel-provider.interface';

@Injectable()
export class ChannelRegistry {
  private readonly providers = new Map<string, ChannelProvider>();

  constructor(@Inject(CHANNEL_PROVIDERS) list: ChannelProvider[]) {
    for (const provider of list) {
      if (this.providers.has(provider.type)) {
        throw new Error(`Duplicate channel provider registered for type "${provider.type}"`);
      }
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
      .sort((a, b) => (a.meta.order ?? 100) - (b.meta.order ?? 100) || a.type.localeCompare(b.type))
      .map((provider) => ({
        type: provider.type,
        name: provider.meta.name,
        description: provider.meta.description,
        icon: provider.meta.icon,
        fields: [...provider.fields],
      }));
  }
}
