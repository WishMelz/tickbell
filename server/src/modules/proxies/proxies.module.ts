import { Global, Module } from '@nestjs/common';
import { ProxiesController } from './proxies.controller';
import { ProxiesRepository } from './proxies.repository';
import { ProxiesService } from './proxies.service';

@Global()
@Module({
  controllers: [ProxiesController],
  providers: [ProxiesRepository, ProxiesService],
  exports: [ProxiesRepository, ProxiesService],
})
export class ProxiesModule {}
