import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ValidationError } from './errors';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (request.path.startsWith('/api')) {
      response.setHeader('Cache-Control', 'no-store');
    }

    if (exception instanceof ValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({ error: exception.message || '请求参数无效' });
      return;
    }

    if (exception instanceof ZodError) {
      const first = exception.issues[0];
      response.status(HttpStatus.BAD_REQUEST).json({ error: first?.message || '请求格式无效' });
      return;
    }

    if (exception instanceof ThrottlerException) {
      response.setHeader('Retry-After', '60');
      response.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: '请求过于频繁，请 60 秒后重试' });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message = exception.message || '请求失败';
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (typeof record.error === 'string' && !record.message) {
          message = record.error;
        } else if (typeof record.message === 'string') {
          message = record.message;
        } else if (Array.isArray(record.message) && typeof record.message[0] === 'string') {
          message = record.message[0];
        }
      }

      if (status === HttpStatus.NOT_FOUND && request.path.startsWith('/api') && message.startsWith('Cannot ')) {
        message = '接口不存在';
      }
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
        message = message.includes('32') ? message : '请求体过大，超过限制';
      }
      if (status === HttpStatus.BAD_REQUEST && exception.name === 'BadRequestException' && message.includes('JSON')) {
        message = '请求体必须是合法的 JSON';
      }

      response.status(status).json({ error: message });
      return;
    }

    // Express body-parser errors (invalid JSON or entity too large)
    if (exception && typeof exception === 'object') {
      const err = exception as { type?: string; status?: number; statusCode?: number; message?: string };
      if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
        response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ error: '备份不能超过 32 MB，请使用服务器 SQLite 文件备份恢复' });
        return;
      }
      if (err.type === 'entity.parse.failed' || exception instanceof SyntaxError) {
        response.status(HttpStatus.BAD_REQUEST).json({ error: '请求体必须是合法的 JSON' });
        return;
      }
    }

    this.logger.error(
      { err: exception, path: request.path, method: request.method },
      'Unhandled exception',
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: '服务器处理请求失败' });
  }
}
