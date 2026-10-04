import { HttpError, type HttpClientLike, type HttpRequest, type HttpResponse, type TlsOptions } from '../http/client.js';
import { redact } from '../security/redact.js';
import { kindForStatus, ProviderError, type ProviderName } from './errors.js';

export interface ProviderOptions {
  http: HttpClientLike;
  baseUrl: string;
  tls?: TlsOptions;
  timeoutMs?: number;
  /** Retries for idempotent reads only (mutations are verified by re-reading instead). */
  readRetries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared request handling for JSON APIs: retries for reads, error classification, redaction. */
export abstract class JsonApiProvider {
  protected abstract readonly name: ProviderName;
  protected readonly baseUrl: string;

  constructor(protected readonly opts: ProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  /** Secret values that must never appear in an error message. */
  protected abstract secretValues(): string[];

  protected async send(req: Omit<HttpRequest, 'url'> & { path: string }): Promise<HttpResponse> {
    const retries = req.method === 'GET' ? (this.opts.readRetries ?? 2) : 0;
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.opts.http.request({
          ...req,
          url: `${this.baseUrl}${req.path}`,
          tls: this.opts.tls,
          timeoutMs: req.timeoutMs ?? this.opts.timeoutMs ?? 10_000,
          secrets: this.secretValues(),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          attempt++;
          await sleep((this.opts.retryDelayMs ?? 250) * attempt);
          continue;
        }
        return res;
      } catch (err) {
        if (err instanceof HttpError) {
          if ((err.kind === 'network' || err.kind === 'timeout') && attempt < retries) {
            attempt++;
            await sleep((this.opts.retryDelayMs ?? 250) * attempt);
            continue;
          }
          throw new ProviderError(`${this.label()}: ${redact(err.message, this.secretValues())}`, this.name, {
            kind: err.kind,
            retryable: err.kind === 'network' || err.kind === 'timeout',
          });
        }
        throw err;
      }
    }
  }

  protected label(): string {
    return { cloudflare: 'Cloudflare API', proxmox: 'Proxmox API', npm: 'Nginx Proxy Manager API' }[this.name];
  }

  protected parseJson<T>(res: HttpResponse): T {
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new ProviderError(`${this.label()} returned invalid JSON (HTTP ${res.status})`, this.name, {
        status: res.status,
        kind: 'invalid_response',
      });
    }
  }

  protected httpFailure(res: HttpResponse, detail?: string): ProviderError {
    const kind = kindForStatus(res.status);
    const msg = detail ? redact(detail, this.secretValues()) : res.text.slice(0, 200);
    const base = kind === 'auth' ? 'authentication failed' : kind === 'rate_limited' ? 'rate limited' : `HTTP ${res.status}`;
    return new ProviderError(`${this.label()}: ${base}${msg ? ` (${redact(msg, this.secretValues())})` : ''}`, this.name, {
      status: res.status,
      kind,
      retryable: kind === 'rate_limited' || kind === 'server',
    });
  }
}
