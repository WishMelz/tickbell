import { Module } from '@nestjs/common';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  imports: [SchedulerModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
