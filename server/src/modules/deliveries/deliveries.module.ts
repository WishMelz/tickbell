import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { RemindersModule } from '../reminders/reminders.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveriesService } from './deliveries.service';

@Module({
  imports: [ChannelsModule, RemindersModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesRepository, DeliveriesService],
  exports: [DeliveriesRepository, DeliveriesService],
})
export class DeliveriesModule {}
