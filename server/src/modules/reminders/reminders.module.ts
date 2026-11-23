import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { RemindersController } from './reminders.controller';
import { RemindersRepository } from './reminders.repository';
import { RemindersService } from './reminders.service';

@Module({
  imports: [ChannelsModule],
  controllers: [RemindersController],
  providers: [RemindersRepository, RemindersService],
  exports: [RemindersRepository, RemindersService],
})
export class RemindersModule {}
