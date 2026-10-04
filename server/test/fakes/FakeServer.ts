import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
  json<T = unknown>(): T;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Fault {
  method?: string;
  path?: RegExp;
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  /** Destroy the socket without responding. */
  drop?: boolean;
  /** How many matching requests to affect; Infinity for "until cleared". */
  times?: number;
  /** Skip this many matching requests before the fault applies. */
  after?: number;
}

/**
 * Loopback-only HTTP server used to impersonate Cloudflare, Proxmox, NPM and
 * the protected applications in tests. Supports fault injection so failure
 * scenarios are deterministic.
 */
export class FakeServer {
  private server: Server | null = null;
  private faults: Array<Fault & { seen: number; applied: number }> = [];
  readonly requests: Array<{ method: string; path: string; body: string; headers: IncomingMessage['headers'] }> = [];
  url = '';

  constructor(private readonly handler: (req: FakeRequest) => FakeResponse | Promise<FakeResponse>) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  fault(f: Fault): this {
    this.faults.push({ ...f, seen: 0, applied: 0 });
    return this;
  }

  clearFaults(): void {
    this.faults = [];
  }

  countRequests(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, body, headers: req.headers });

    const fault = this.faults.find((f) => {
      if (f.method && f.method !== method) return false;
      if (f.path && !f.path.test(url.pathname)) return false;
      f.seen++;
      if (f.after && f.seen <= f.after) return false;
      return f.applied < (f.times ?? Infinity);
    });
    if (fault) {
      fault.applied++;
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault.drop) {
        req.socket.destroy();
        return;
      }
      if (fault.status !== undefined || fault.rawBody !== undefined || fault.body !== undefined) {
        res.statusCode = fault.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(fault.rawBody ?? JSON.stringify(fault.body ?? { error: 'injected fault' }));
        return;
      }
    }

    try {
      const out = await this.handler({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json: <T>() => (body ? JSON.parse(body) : {}) as T,
      });
      res.statusCode = out.status ?? 200;
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      if (typeof out.body === 'string') res.end(out.body);
      else {
        if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.body ?? {}));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }
}
