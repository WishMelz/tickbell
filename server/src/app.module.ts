import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { BackupModule } from './modules/backup/backup.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { DatabaseModule } from './modules/database/database.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SystemModule } from './modules/system/system.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          autoLogging: config.nodeEnv !== 'test',
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          transport:
            config.nodeEnv === 'development'
              ? {
                  target: 'pino-pretty',
                  options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss' },
                }
              : undefined,
        },
      }),
    }),
    ThrottlerModule.forRoot([
      {
        name: 'auth',
        ttl: 60_000,
        limit: 5,
      },
    ]),
    ServeStaticModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const indexPath = path.join(config.staticDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
          return [];
        }
        return [
          {
            rootPath: config.staticDir,
            exclude: ['/api/{*path}'],
            serveStaticOptions: {
              setHeaders: (res, filePath) => {
                if (filePath.endsWith('index.html')) {
                  res.setHeader('Cache-Control', 'no-cache');
                } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
                  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
              },
            },
          },
        ];
      },
    }),
    DatabaseModule,
    SettingsModule,
    AuthModule,
    NotificationsModule,
    ChannelsModule,
    RemindersModule,
    DeliveriesModule,
    SchedulerModule,
    BackupModule,
    SystemModule,
  ],
})
export class AppModule {}
