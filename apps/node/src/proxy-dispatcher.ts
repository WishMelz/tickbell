import * as net from 'node:net';
import * as tls from 'node:tls';
import type { ProxyTarget } from '@tickbell/core';
import { Agent, type Dispatcher, ProxyAgent } from 'undici';

function stripHostBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function formatHostForUrl(host: string): string {
  const clean = stripHostBrackets(host.trim());
  return clean.includes(':') ? `[${clean}]` : clean;
}

const SOCKS5_REPLY_MESSAGES: Record<number, string> = {
  0x01: 'SOCKS5 代理服务器内部错误',
  0x02: 'SOCKS5 代理规则拒绝连接',
  0x03: 'SOCKS5 目标网络不可达',
  0x04: 'SOCKS5 目标主机不可达',
  0x05: 'SOCKS5 目标拒绝连接',
  0x06: 'SOCKS5 连接 TTL 超时',
  0x07: 'SOCKS5 不支持的命令',
  0x08: 'SOCKS5 不支持的地址类型',
};

class SocketHandshakeReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private waiter: { needed: number; resolve: (buf: Buffer) => void; reject: (err: Error) => void } | null = null;

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.flush();
  };

  private readonly onError = (err: Error) => {
    this.failure = err;
    this.flush();
  };

  private readonly onClose = () => {
    this.ended = true;
    this.flush();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('end', this.onClose);
  }

  private flush(): void {
    if (!this.waiter) return;
    if (this.buffer.length >= this.waiter.needed) {
      const { needed, resolve } = this.waiter;
      this.waiter = null;
      const out = this.buffer.subarray(0, needed);
      this.buffer = this.buffer.subarray(needed);
      resolve(out);
      return;
    }
    if (this.failure) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.failure);
      return;
    }
    if (this.ended) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(new Error('SOCKS5 代理提前关闭了连接'));
    }
  }

  readExact(bytes: number): Promise<Buffer> {
    if (this.buffer.length >= bytes) {
      const out = this.buffer.subarray(0, bytes);
      this.buffer = this.buffer.subarray(bytes);
      return Promise.resolve(out);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error('SOCKS5 代理提前关闭了连接'));
    return new Promise<Buffer>((resolve, reject) => {
      this.waiter = { needed: bytes, resolve, reject };
    });
  }

  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.off('end', this.onClose);
    if (this.buffer.length > 0) {
      const leftover = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.socket.unshift(leftover);
    }
  }
}

function writeAll(socket: net.Socket, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function encodeSocks5TargetAddress(rawHost: string): Buffer {
  const host = stripHostBrackets(rawHost.trim());
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const octets = host.split('.').map((part) => Number.parseInt(part, 10));
    return Buffer.from([0x01, ...octets]);
  }
  const hostBuf = Buffer.from(host, 'utf8');
  if (hostBuf.length === 0 || hostBuf.length > 255) {
    throw new Error('目标主机名长度超出 SOCKS5 协议限制');
  }
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
}

async function openSocks5Tunnel(
  proxy: ProxyTarget,
  targetHost: string,
  targetPort: number,
  useTls: boolean,
  servername: string,
  connectTimeoutMs: number,
): Promise<net.Socket> {
  const proxyHost = stripHostBrackets(proxy.host.trim());
  const socket = net.connect({ host: proxyHost, port: proxy.port });
  let handshakeDone = false;

  const timer = setTimeout(() => {
    if (!handshakeDone) {
      const err = Object.assign(new Error('连接 SOCKS5 代理超时'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      socket.destroy(err);
    }
  }, connectTimeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off('connect', onConnect);
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    const reader = new SocketHandshakeReader(socket);
    try {
      const username = proxy.username ?? '';
      const password = proxy.password ?? '';
      const hasAuth = username.length > 0 || password.length > 0;

      const greeting = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      await writeAll(socket, greeting);

      const methodResp = await reader.readExact(2);
      if (methodResp[0] !== 0x05) throw new Error('SOCKS5 代理握手响应无效');
      const chosenMethod = methodResp[1];
      if (chosenMethod === 0xff) {
        throw new Error('SOCKS5 代理拒绝了认证方式（可能需要用户名和密码）');
      }

      if (chosenMethod === 0x02) {
        const userBuf = Buffer.from(username, 'utf8');
        const passBuf = Buffer.from(password, 'utf8');
        if (userBuf.length > 255 || passBuf.length > 255) {
          throw new Error('SOCKS5 代理用户名或密码过长');
        }
        const authReq = Buffer.concat([
          Buffer.from([0x01, userBuf.length]),
          userBuf,
          Buffer.from([passBuf.length]),
          passBuf,
        ]);
        await writeAll(socket, authReq);
        const authResp = await reader.readExact(2);
        if (authResp[1] !== 0x00) {
          throw new Error('SOCKS5 代理认证失败，请检查用户名和密码');
        }
      } else if (chosenMethod !== 0x00) {
        throw new Error(`SOCKS5 代理返回了不支持的认证方式（0x${chosenMethod?.toString(16)}）`);
      }

      const addrBuf = encodeSocks5TargetAddress(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);
      const connectReq = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuf, portBuf]);
      await writeAll(socket, connectReq);

      const replyHead = await reader.readExact(4);
      if (replyHead[0] !== 0x05) throw new Error('SOCKS5 代理 CONNECT 响应无效');
      const rep = replyHead[1] ?? 0x01;
      if (rep !== 0x00) {
        throw new Error(SOCKS5_REPLY_MESSAGES[rep] ?? `SOCKS5 代理连接失败（错误码 ${rep}）`);
      }

      const atyp = replyHead[3];
      if (atyp === 0x01) {
        await reader.readExact(6);
      } else if (atyp === 0x03) {
        const lenBuf = await reader.readExact(1);
        await reader.readExact((lenBuf[0] ?? 0) + 2);
      } else if (atyp === 0x04) {
        await reader.readExact(18);
      } else {
        throw new Error('SOCKS5 代理返回了未知地址类型');
      }
    } finally {
      reader.detach();
    }

    if (!useTls) {
      handshakeDone = true;
      return socket;
    }

    const cleanServername = stripHostBrackets(servername);
    const tlsSocket = tls.connect({
      socket,
      servername: net.isIP(cleanServername) ? undefined : cleanServername,
    });

    await new Promise<void>((resolve, reject) => {
      const onSecure = () => {
        tlsSocket.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        tlsSocket.off('secureConnect', onSecure);
        reject(err);
      };
      tlsSocket.once('secureConnect', onSecure);
      tlsSocket.once('error', onError);
    });

    handshakeDone = true;
    return tlsSocket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createProxyDispatcher(proxy: ProxyTarget, timeoutMs: number): Dispatcher {
  const connectTimeout = Math.min(timeoutMs, 10_000);

  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    const uri = `${proxy.protocol}://${formatHostForUrl(proxy.host)}:${proxy.port}`;
    const hasAuth = Boolean((proxy.username && proxy.username.length > 0) || (proxy.password && proxy.password.length > 0));
    const token = hasAuth
      ? `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`, 'utf8').toString('base64')}`
      : undefined;

    return new ProxyAgent({
      uri,
      token,
      connectTimeout,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  return new Agent({
    connectTimeout,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: (opts, callback) => {
      const useTls = opts.protocol === 'https:';
      const targetPort = opts.port ? Number(opts.port) : useTls ? 443 : 80;
      const targetHost = opts.hostname;
      const servername = opts.servername || targetHost;
      void openSocks5Tunnel(proxy, targetHost, targetPort, useTls, servername, connectTimeout)
        .then((sock) => callback(null, sock))
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null));
    },
  });
}
