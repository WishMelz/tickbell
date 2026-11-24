export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
    this.name = 'ValidationError';
  }
}

export function unauthorized(message = '请先登录'): AppError {
  return new AppError(401, message);
}

export function notFound(message = '资源不存在'): AppError {
  return new AppError(404, message);
}

export function conflict(message: string): AppError {
  return new AppError(409, message);
}

export function payloadTooLarge(message: string): AppError {
  return new AppError(413, message);
}

export function tooManyRequests(message = '请求过于频繁，请稍后再试'): AppError {
  return new AppError(429, message);
}

export function serviceUnavailable(message: string): AppError {
  return new AppError(503, message);
}

export function notImplemented(message = '当前运行环境不支持此功能'): AppError {
  return new AppError(501, message);
}
