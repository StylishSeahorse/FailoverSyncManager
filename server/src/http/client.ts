import { Agent, buildConnector, request as undiciRequest, errors as undiciErrors, type Dispatcher } from 'undici';
import { redact } from '../security/redact.js';
import { EgressGuard } from './egress.js';

export interface TlsOptions {
  /** PEM CA bundle to trust for this endpoint (pinning a private CA). */
  caPem?: string | null;
  /** Disable certificate verification. Insecure; surfaced in UI/audit. */
  insecure?: boolean;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  timeoutMs?: number;
  tls?: TlsOptions;
  /** Secret values to scrub from any error message produced by this request. */
  secrets?: string[];
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  latencyMs: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'network' | 'tls' | 'blocked',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClientLike {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class HttpClient implements HttpClientLike {
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly guard: EgressGuard,
    private readonly defaultTimeoutMs = 10_000,
  ) {}

  get egress(): EgressGuard {
    return this.guard;
  }

  /**
   * Every connection goes through a connector that re-checks the egress
   * allow-list against the address actually dialled (defence in depth beyond
   * the URL check in request()).
   */
  private agentFor(tls: TlsOptions | undefined): Dispatcher {
    const key = `${tls?.insecure ? 'i' : 's'}:${tls?.caPem ?? ''}`;
    let agent = this.agents.get(key);
    if (!agent) {
      const base = buildConnector({ rejectUnauthorized: !tls?.insecure, ...(tls?.caPem ? { ca: tls.caPem } : {}) });
      const guard = this.guard;
      const connect: buildConnector.connector = (opts, cb) => {
        if (!guard.isAllowed(opts.hostname)) {
          cb(new Error(`Outbound connection to "${opts.hostname}" blocked by egress allow-list`), null);
          return;
        }
        base(opts, cb);
      };
      agent = new Agent({ connect, keepAliveTimeout: 10_000 });
      this.agents.set(key, agent);
    }
    return agent;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError(`Unsupported protocol ${url.protocol}`, 'blocked');
    }
    if (!this.guard.isAllowed(url.hostname)) {
      throw new HttpError(`Outbound connection to "${url.hostname}" blocked by egress allow-list`, 'blocked');
    }
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | undefined = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = 'application/json';
    }
    const started = performance.now();
    try {
      const res = await undiciRequest(url, {
        method: req.method,
        headers,
        body,
        dispatcher: this.agentFor(req.tls),
        signal: AbortSignal.timeout(timeoutMs),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const text = await res.body.text();
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      return { status: res.statusCode, headers: outHeaders, text, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      throw this.classify(err, url, timeoutMs, req.secrets ?? []);
    }
  }

  private classify(err: unknown, url: URL, timeoutMs: number, secrets: string[]): HttpError {
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e.code ?? e.cause?.code ?? '';
    const where = `${url.protocol}//${url.host}`;
    if (
      e.name === 'TimeoutError' ||
      e.name === 'AbortError' ||
      err instanceof undiciErrors.HeadersTimeoutError ||
      err instanceof undiciErrors.BodyTimeoutError ||
      code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return new HttpError(`Request to ${where} timed out after ${timeoutMs} ms`, 'timeout');
    }
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
      return new HttpError(`TLS verification failed for ${where}: ${code}`, 'tls');
    }
    const detail = redact(e.cause?.message ?? e.message ?? String(err), secrets);
    return new HttpError(`Request to ${where} failed: ${code ? code + ' ' : ''}${detail}`.trim(), 'network');
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.close()));
    this.agents.clear();
  }
}
