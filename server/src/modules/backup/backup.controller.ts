import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ValidationError } from '../../common/errors';
import { AuthThrottlerGuard } from '../auth/auth-throttler.guard';
import { AuthService, SESSION_COOKIE_NAME } from '../auth/auth.service';
import { BackupService } from './backup.service';

@Controller('backup')
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly auth: AuthService,
  ) {}

  private assertAdminPassword(body: unknown): void {
    const password =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).password : null;
    if (typeof password !== 'string' || !this.auth.verifyPassword(password)) {
      throw new ValidationError('管理密码不正确');
    }
  }

  @Get('auto')
  getAutoBackup() {
    return this.backup.getAutoBackupView();
  }

  @Put('auto')
  updateAutoBackup(@Body() body: unknown) {
    return this.backup.updateAutoBackupConfig(body);
  }

  @Post('auto/run')
  @HttpCode(HttpStatus.OK)
  runAutoBackupNow() {
    return this.backup.runAutoBackupNow();
  }

  @Get('auto/files/:name')
  readAutoBackupFile(@Param('name') name: string) {
    return this.backup.readAutoBackupFile(name);
  }

  @Delete('auto/files/:name')
  deleteAutoBackupFile(@Param('name') name: string) {
    return this.backup.deleteAutoBackupFile(name);
  }

  @UseGuards(AuthThrottlerGuard)
  @Post('export')
  @HttpCode(HttpStatus.OK)
  export(@Body() body: unknown) {
    this.assertAdminPassword(body);
    return this.backup.export();
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() body: unknown) {
    const payload =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).backup : undefined;
    return this.backup.preview(payload);
  }

  @UseGuards(AuthThrottlerGuard)
  @Post('restore')
  @HttpCode(HttpStatus.OK)
  async restore(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const record =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (record.confirmation !== 'RESTORE') {
      throw new ValidationError('请输入 RESTORE 确认覆盖恢复');
    }
    this.assertAdminPassword(record);
    await this.backup.restore(record.backup);
    res.clearCookie(SESSION_COOKIE_NAME, this.auth.clearCookieOptions(req));
    return { restored: true };
  }
}
