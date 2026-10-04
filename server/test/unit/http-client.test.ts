import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from '../../src/http/client.js';
import { EgressGuard } from '../../src/http/egress.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
      return;
    }
    res.setHeader('x-site', 'b');
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('EgressGuard', () => {
  it('matches exact hosts and wildcard suffixes', () => {
    const g = new EgressGuard(['api.cloudflare.com', '*.lan']);
    expect(g.isAllowed('api.cloudflare.com')).toBe(true);
    expect(g.isAllowed('pve-a.lan')).toBe(true);
    expect(g.isAllowed('evil.com')).toBe(false);
    expect(g.isAllowed('lan')).toBe(false);
  });
  it('allows anything with *', () => {
    expect(new EgressGuard('*').isAllowed('x.y')).toBe(true);
  });
});

describe('HttpClient', () => {
  const client = new HttpClient(new EgressGuard(['127.0.0.1']));
  afterAll(() => client.close());

  it('performs requests and lowercases headers', async () => {
    const res = await client.request({ method: 'POST', url: `${base}/x`, json: { a: 1 } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ path: '/x', method: 'POST' });
    expect(res.headers['x-site']).toBe('b');
  });

  it('blocks hosts outside the allow-list before connecting', async () => {
    await expect(client.request({ method: 'GET', url: 'https://api.cloudflare.com/client/v4/zones' })).rejects.toMatchObject({
      kind: 'blocked',
    });
  });

  it('times out', async () => {
    const err = await client.request({ method: 'GET', url: `${base}/slow`, timeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('timeout');
  });

  it('reports connection failures as network errors', async () => {
    const err = await client.request({ method: 'GET', url: 'http://127.0.0.1:1/' }).catch((e) => e);
    expect(err.kind).toBe('network');
  });

  it('rejects non-http protocols', async () => {
    await expect(client.request({ method: 'GET', url: 'file:///etc/passwd' })).rejects.toMatchObject({ kind: 'blocked' });
  });
});

describe('test safety net', () => {
  it('blocks raw sockets to non-loopback addresses', async () => {
    const net = await import('node:net');
    expect(() => net.connect(443, '1.1.1.1')).toThrow(/TEST SAFETY/);
  });
});

describe('Host header override', () => {
  it('dials the URL host, not the Host header name', async () => {
    const client = new HttpClient(new EgressGuard(['127.0.0.1']));
    const res = await client.request({ method: 'GET', url: `${base}/h`, headers: { host: 'www.example.com' } });
    expect(res.status).toBe(200);
    await client.close();
  });
});
