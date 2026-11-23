import { Body, Controller, Get, Put } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getSettings(): { globalTimezone: string } {
    return { globalTimezone: this.settings.getGlobalTimezone() };
  }

  @Put()
  updateSettings(@Body() body: unknown): { globalTimezone: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('请求体必须是 JSON 对象');
    }
    const globalTimezone = this.settings.setGlobalTimezone((body as Record<string, unknown>).globalTimezone);
    return { globalTimezone };
  }
}
