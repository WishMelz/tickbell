import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pinnedHttpPost,
  pinnedHttpRequest,
  sanitizeSensitiveText,
} from '../src/modules/notifications/http/pinned-fetch';
import { runWithProxyContext } from '../src/modules/notifications/http/proxy-dispatcher';
import { PrivateNetworkPolicy } from '../src/modules/notifications/http/url-policy';

const serversToClose: Array<http.Server | net.Server> = [];

afterEach(async () => {
  while (serversToClose.length) {
    const srv = serversToClose.pop();
    if (!srv) continue;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

async function startTargetHttpServer(): Promise<{ port: number; received: Array<{ method: string; url: string; body: string }> }> {
  const received: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'target' }));
    });
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return { port: addr.port, received };
}

async function startMockHttpProxy(expectedAuth?: string): Promise<{ port: number; proxiedUrls: string[] }> {
  const proxiedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      res.end('Proxy Auth Required');
      return;
    }
    const targetUrl = new URL(req.url!);
    proxiedUrls.push(targetUrl.toString());
    const upstream = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    req.pipe(upstream);
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return { port: addr.port, proxiedUrls };
}

async function startMockSocks5Proxy(expectedCreds?: { user: string; pass: string }): Promise<{
  port: number;
  tunneledTargets: string[];
}> {
  const tunneledTargets: string[] = [];
  const server = net.createServer((client) => {
    let stage: 'greeting' | 'auth' | 'connect' | 'piping' = 'greeting';
    let buf: Buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      while (true) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nMethods = buf[1]!;
          if (buf.length < 2 + nMethods) return;
          const methods = [...buf.subarray(2, 2 + nMethods)];
          buf = buf.subarray(2 + nMethods);

          if (expectedCreds) {
            if (!methods.includes(0x02)) {
              client.write(Buffer.from([0x05, 0xff]));
              client.end();
              return;
            }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'connect';
          }
          continue;
        }

        if (stage === 'auth') {
          if (buf.length < 2) return;
          const uLen = buf[1]!;
          if (buf.length < 3 + uLen) return;
          const user = buf.subarray(2, 2 + uLen).toString('utf8');
          const pLen = buf[2 + uLen]!;
          if (buf.length < 3 + uLen + pLen) return;
          const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8');
          buf = buf.subarray(3 + uLen + pLen);

          if (expectedCreds && (user !== expectedCreds.user || pass !== expectedCreds.pass)) {
            client.write(Buffer.from([0x01, 0x01]));
            client.end();
            return;
          }
          client.write(Buffer.from([0x01, 0x00]));
          stage = 'connect';
          continue;
        }

        if (stage === 'connect') {
          if (buf.length < 4) return;
          const atyp = buf[3]!;
          let host = '';
          let headerLen = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            headerLen = 10;
          } else if (atyp === 0x03) {
            if (buf.length < 5) return;
            const dLen = buf[4]!;
            if (buf.length < 7 + dLen) return;
            host = buf.subarray(5, 5 + dLen).toString('utf8');
            headerLen = 7 + dLen;
          } else {
            client.end();
            return;
          }
          const port = buf.readUInt16BE(headerLen - 2);
          const leftover = buf.subarray(headerLen);
          buf = Buffer.alloc(0);
          stage = 'piping';
          client.off('data', onData);
          tunneledTargets.push(`${host}:${port}`);

          const upstream = net.connect({ host, port }, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (leftover.length > 0) upstream.write(leftover);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on('error', () => {
            client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.end();
          });
          return;
        }
        return;
      }
    };

    client.on('data', onData);
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return { port: addr.port, tunneledTargets };
}

describe('proxy transport (HTTP & SOCKS5)', () => {
  const policy = new PrivateNetworkPolicy([], true);

  it('routes POST requests through an authenticated HTTP proxy via AsyncLocalStorage context', async () => {
    const target = await startTargetHttpServer();
    const expectedAuth = `Basic ${Buffer.from('alice:secret123').toString('base64')}`;
    const proxy = await startMockHttpProxy(expectedAuth);

    const res = await runWithProxyContext(
      { protocol: 'http', host: '127.0.0.1', port: proxy.port, username: 'alice', password: 'secret123' },
      () =>
        pinnedHttpPost({
          url: `http://127.0.0.1:${target.port}/notify`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hello: 'world' }),
          policy,
        }),
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(proxy.proxiedUrls).toEqual([`http://127.0.0.1:${target.port}/notify`]);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]?.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('rejects with HTTP 407 when HTTP proxy credentials do not match', async () => {
    const target = await startTargetHttpServer();
    const expectedAuth = `Basic ${Buffer.from('alice:correct').toString('base64')}`;
    const proxy = await startMockHttpProxy(expectedAuth);

    await expect(
      pinnedHttpRequest({
        url: `http://127.0.0.1:${target.port}/ping`,
        method: 'GET',
        policy,
        proxy: { protocol: 'http', host: '127.0.0.1', port: proxy.port, username: 'alice', password: 'wrong' },
      }),
    ).rejects.toThrow(/407/);
    expect(target.received).toHaveLength(0);
  });

  it('routes requests through an authenticated SOCKS5 proxy and rejects wrong credentials', async () => {
    const target = await startTargetHttpServer();
    const socks = await startMockSocks5Proxy({ user: 'bob', pass: 's3cr3t' });

    const res = await runWithProxyContext(
      { protocol: 'socks5', host: '127.0.0.1', port: socks.port, username: 'bob', password: 's3cr3t' },
      () =>
        pinnedHttpPost({
          url: `http://127.0.0.1:${target.port}/socks-hook`,
          headers: { 'Content-Type': 'application/json' },
          body: '{"from":"socks5"}',
          policy,
        }),
    );

    expect(res.ok).toBe(true);
    expect(socks.tunneledTargets).toEqual([`127.0.0.1:${target.port}`]);
    expect(target.received[0]?.url).toBe('/socks-hook');

    await expect(
      pinnedHttpRequest({
        url: `http://127.0.0.1:${target.port}/socks-hook`,
        method: 'GET',
        policy,
        proxy: { protocol: 'socks5', host: '127.0.0.1', port: socks.port, username: 'bob', password: 'bad' },
      }),
    ).rejects.toThrow('SOCKS5 代理认证失败');
  });

  it('redacts proxy credentials in error/log strings', () => {
    expect(sanitizeSensitiveText('failed via socks5://alice:myPass!@127.0.0.1:1080')).toBe(
      'failed via socks5://[REDACTED]@127.0.0.1:1080',
    );
    expect(sanitizeSensitiveText('connect http://u:p@proxy.local:8080 failed')).toBe(
      'connect http://[REDACTED]@proxy.local:8080 failed',
    );
  });
});
