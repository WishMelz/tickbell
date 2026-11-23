import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = configureApp(app);
  await app.listen(config.port, config.host);
  logger.log(`TickBell server listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
}

void bootstrap();
