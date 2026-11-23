import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ChannelsService } from './channels.service';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('types')
  listTypes() {
    return this.channels.listTypes();
  }

  @Get()
  list() {
    return this.channels.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown) {
    return this.channels.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.channels.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.channels.delete(id);
    return null;
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  test(@Param('id') id: string) {
    return this.channels.test(id);
  }
}
