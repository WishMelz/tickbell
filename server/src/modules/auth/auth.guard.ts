import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators';
import { serviceUnavailable, unauthorized } from '../../common/errors';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!this.auth.isInitialized()) {
      throw serviceUnavailable('系统尚未完成首次初始化，请先设置管理密码和密钥');
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!this.auth.hasValidSession(request)) {
      throw unauthorized('请先登录');
    }
    return true;
  }
}
