import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { epochToIso } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { ChannelsRepository } from '../channels/channels.repository';
import { DatabaseService } from '../database/database.service';
import { DeliveriesRepository } from '../deliveries/deliveries.repository';
import { RemindersRepository } from '../reminders/reminders.repository';
import { SchedulerService } from '../scheduler/scheduler.service';

const APP_VERSION = '1.0.0';

@Controller()
export class SystemController {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly scheduler: SchedulerService,
    private readonly remindersRepo: RemindersRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly deliveriesRepo: DeliveriesRepository,
  ) {}

  @Public()
  @Get('health')
  health(@Res({ passthrough: true }) res: Response) {
    const dbOk = this.database.ping();
    const schedulerHealth = this.scheduler.getHealth();
    const ok = dbOk && schedulerHealth.healthy;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      scheduler: schedulerHealth,
    };
  }

  @Get('system/status')
  status() {
    return {
      version: APP_VERSION,
      startedAt: epochToIso(this.startedAt),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      nodeVersion: process.version,
      scheduler: this.scheduler.getStatus(),
      counts: {
        reminders: this.remindersRepo.countActive(),
        activeReminders: this.remindersRepo.countEnabledActive(),
        channels: this.channelsRepo.countAll(),
        retryingDeliveries: this.deliveriesRepo.countRetrying(),
      },
      limits: {
        maxReminders: this.config.maxReminders,
        missedGraceMinutes: this.config.missedGraceMinutes,
        deliveryRetentionDays: this.config.deliveryRetentionDays,
      },
      backup: this.scheduler.getBackupStatus(),
    };
  }
}
