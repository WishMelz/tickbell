import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), RemindersModule, DeliveriesModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
