import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { serviceUnavailable, unauthorized, ValidationError } from '../../common/errors';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AuthService, SESSION_COOKIE_NAME } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('status')
  status(@Req() req: Request) {
    const initialized = this.auth.isInitialized();
    const configurationIssue = this.auth.getConfigurationIssue();
    const authenticated = initialized && this.auth.hasValidSession(req);
    return { initialized, configured: initialized, authenticated, configurationIssue };
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  setup(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const record =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    this.auth.setup({
      password: record.password,
      secret: record.secret,
      globalTimezone: record.globalTimezone,
    });
    res.cookie(SESSION_COOKIE_NAME, this.auth.createSessionToken(), this.auth.sessionCookieOptions(req));
    return { authenticated: true };
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!this.auth.isInitialized()) {
      throw serviceUnavailable('系统尚未完成首次初始化，请先设置管理密码和密钥');
    }
    const password =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).password : null;
    if (typeof password !== 'string' || !password) {
      throw new ValidationError('请输入密码');
    }
    if (!this.auth.verifyPassword(password)) {
      throw unauthorized('密码不正确');
    }
    res.cookie(SESSION_COOKIE_NAME, this.auth.createSessionToken(), this.auth.sessionCookieOptions(req));
    return { authenticated: true };
  }

  @UseGuards(AuthThrottlerGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const record =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    this.auth.changePassword(record.currentPassword, record.newPassword);
    // Keep the current browser logged in with a fresh cookie while invalidating other sessions
    res.cookie(SESSION_COOKIE_NAME, this.auth.createSessionToken(), this.auth.sessionCookieOptions(req));
    return { changed: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE_NAME, this.auth.clearCookieOptions(req));
    return null;
  }
}
