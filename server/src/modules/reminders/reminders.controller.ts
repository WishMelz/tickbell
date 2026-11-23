import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { RemindersService } from './reminders.service';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('status') status?: string,
  ) {
    return this.reminders.list({ search, category, tag, status });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown) {
    return this.reminders.create(body);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  batch(@Body() body: unknown) {
    return this.reminders.batch(body);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@Body() body: unknown) {
    return this.reminders.test(body);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.reminders.getById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.reminders.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.reminders.softDelete(id);
    return null;
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  enable(@Param('id') id: string) {
    return this.reminders.enable(id);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(@Param('id') id: string) {
    return this.reminders.disable(id);
  }
}
