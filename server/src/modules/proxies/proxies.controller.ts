import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ProxiesService } from './proxies.service';

@Controller('proxies')
export class ProxiesController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  list() {
    return this.proxies.list();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.proxies.create(body);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  testAdhoc(@Body() body: unknown) {
    return this.proxies.testAdhoc(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.proxies.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.proxies.delete(id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  testSaved(@Param('id') id: string, @Body() body: unknown) {
    return this.proxies.testSaved(id, body);
  }
}
