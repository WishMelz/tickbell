import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SystemController } from './system.controller';

@Module({
  imports: [ChannelsModule, RemindersModule, DeliveriesModule, SchedulerModule],
  controllers: [SystemController],
})
export class SystemModule {}
