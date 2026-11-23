import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig, envFilePaths, loadAppConfig } from './app-config';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: envFilePaths(),
      validate: (raw) => {
        // Store validated AppConfig under a dedicated key so ConfigService and APP_CONFIG share one source of truth.
        const appConfig = loadAppConfig(raw);
        return { ...raw, __appConfig: appConfig };
      },
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): AppConfig => {
        const config = configService.get<AppConfig>('__appConfig');
        if (!config) {
          return loadAppConfig(process.env);
        }
        return config;
      },
    },
  ],
  exports: [APP_CONFIG, ConfigModule],
})
export class AppConfigModule {}
