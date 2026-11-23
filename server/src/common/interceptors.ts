import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';

/** Wraps controller return values in `{ data }` and sets `Cache-Control: no-store` on `/api/*`. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    if (request.path.startsWith('/api')) {
      response.setHeader('Cache-Control', 'no-store');
    }
    return next.handle().pipe(
      map((value) => {
        if (value === undefined) return { data: null };
        return { data: value };
      }),
    );
  }
}
