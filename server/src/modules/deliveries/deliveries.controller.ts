import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';

@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  list(
    @Query('reminderId') reminderId?: string,
    @Query('channelId') channelId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.deliveries.listPage({ reminderId, channelId, status, page, pageSize });
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id') id: string) {
    return this.deliveries.manualRetry(id);
  }
}
