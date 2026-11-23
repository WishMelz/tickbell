import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters';
import { ResponseEnvelopeInterceptor } from './common/interceptors';
import { APP_CONFIG, type AppConfig } from './config/app-config';

/** SHA-256 hash of the THEME-BOOT inline script in `web/index.html`. */
const KNOWN_THEME_BOOT_HASH = "'sha256-xztgba/Al1wIr7KsZpe2jfxPytILlQw+rs8CNMf9vic='";

function collectInlineScriptHashes(staticDir: string): string[] {
  const hashes = new Set<string>([KNOWN_THEME_BOOT_HASH]);
  const indexPath = path.join(staticDir, 'index.html');
  if (!fs.existsSync(indexPath)) return [...hashes];

  try {
    const html = fs.readFileSync(indexPath, 'utf8');
    const regex = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const fullTag = match[0];
      const body = match[1] ?? '';
      if (/\bsrc\s*=/i.test(fullTag) || !body.trim()) continue;
      const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
      hashes.add(`'sha256-${digest}'`);
    }
  } catch {
    // fallback to known hash
  }
  return [...hashes];
}

export function configureApp(app: INestApplication): AppConfig {
  const expressApp = app as NestExpressApplication;
  const config = app.get<AppConfig>(APP_CONFIG);

  expressApp.set('trust proxy', config.trustProxy);
  expressApp.disable('x-powered-by');

  const strictHttps = config.cookieSecure === 'true';
  const scriptHashes = collectInlineScriptHashes(config.staticDir);
  app.use(
    helmet({
      hsts: strictHttps ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...scriptHashes],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: strictHttps ? [] : null,
        },
      },
      referrerPolicy: { policy: 'same-origin' },
      frameguard: { action: 'deny' },
    }),
  );

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Ensure SPA HTML fallback routes are never cached aggressively
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    next();
  });

  app.use(cookieParser());

  // Larger JSON body limit exclusively for full backup preview/restore (32 MiB + envelope overhead)
  const backupJsonParser = express.json({ limit: 32 * 1024 * 1024 + 64 * 1024 });
  const defaultJsonParser = express.json({ limit: '1mb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/backup')) {
      backupJsonParser(req, res, next);
    } else {
      defaultJsonParser(req, res, next);
    }
  });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  return config;
}
