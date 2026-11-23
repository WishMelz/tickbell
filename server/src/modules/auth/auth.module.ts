import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AuthService } from './auth.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthThrottlerGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, AuthThrottlerGuard],
})
export class AuthModule {}
