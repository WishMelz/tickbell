import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Business validation error → HTTP 400 with a Chinese, user-readable message.
 * (Ported from Tips `ValidationError`.)
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** HTTP error with a Chinese message; serialized as `{ error }` by the global filter. */
export class AppHttpError extends HttpException {
  constructor(status: HttpStatus, message: string) {
    super(message, status);
  }
}

export const notFound = (message: string) => new AppHttpError(HttpStatus.NOT_FOUND, message);
export const conflict = (message: string) => new AppHttpError(HttpStatus.CONFLICT, message);
export const badRequest = (message: string) => new AppHttpError(HttpStatus.BAD_REQUEST, message);
export const payloadTooLarge = (message: string) => new AppHttpError(HttpStatus.PAYLOAD_TOO_LARGE, message);
export const unauthorized = (message: string) => new AppHttpError(HttpStatus.UNAUTHORIZED, message);
export const serviceUnavailable = (message: string) => new AppHttpError(HttpStatus.SERVICE_UNAVAILABLE, message);
