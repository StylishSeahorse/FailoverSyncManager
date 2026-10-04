import { JsonApiProvider, type ProviderOptions } from '../base.js';
import { ProviderError } from '../errors.js';

export interface NpmCertificate {
  id: number;
  nice_name: string;
  domain_names: string[];
  expires_on: string;
}

export interface NpmProxyHost {
  id: number;
  domain_names: string[];
  forward_scheme: 'http' | 'https';
  forward_host: string;
  forward_port: number;
  enabled: boolean;
  certificate_id: number | 'new' | null;
  ssl_forced: boolean;
  certificate?: NpmCertificate | null;
}

const bool = (v: unknown) => v === true || v === 1 || v === '1';

function normaliseHost(h: Record<string, unknown>): NpmProxyHost {
  return {
    id: Number(h.id),
    domain_names: (h.domain_names as string[]) ?? [],
    forward_scheme: (h.forward_scheme as 'http' | 'https') ?? 'http',
    forward_host: String(h.forward_host ?? ''),
    forward_port: Number(h.forward_port ?? 0),
    enabled: bool(h.enabled),
    certificate_id: (h.certificate_id as number | null) ?? null,
    ssl_forced: bool(h.ssl_forced),
    certificate: (h.certificate as NpmCertificate | null) ?? null,
  };
}

/** Nginx Proxy Manager API. Read-mostly; the only mutations are enable/disable of a proxy host. */
export class NpmProvider extends JsonApiProvider {
  protected readonly name = 'npm' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    opts: ProviderOptions,
    private readonly identity: string,
    private readonly secret: string,
  ) {
    super({ ...opts, baseUrl: `${opts.baseUrl.replace(/\/+$/, '')}/api` });
  }

  protected secretValues(): string[] {
    return [this.secret, ...(this.token ? [this.token.value] : [])];
  }

  /** Unauthenticated status endpoint. */
  async status(): Promise<{ status: string; version?: { major: number; minor: number; revision: number } }> {
    const res = await this.send({ method: 'GET', path: '/' });
    if (res.status !== 200) throw this.httpFailure(res);
    return this.parseJson(res);
  }

  async login(): Promise<void> {
    const res = await this.send({ method: 'POST', path: '/tokens', json: { identity: this.identity, secret: this.secret } });
    if (res.status !== 200) throw this.httpFailure(res, 'login rejected');
    const body = this.parseJson<{ token?: string; expires?: string }>(res);
    if (!body.token) throw new ProviderError('Nginx Proxy Manager login returned no token', 'npm', { kind: 'invalid_response' });
    const exp = body.expires ? Date.parse(body.expires) : Date.now() + 3600_000;
    this.token = { value: body.token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 3600_000 };
  }

  private async authed<T>(method: 'GET' | 'POST', path: string, retried = false): Promise<T> {
    if (!this.token || this.token.expiresAt - 60_000 < Date.now()) await this.login();
    const res = await this.send({ method, path, headers: { authorization: `Bearer ${this.token!.value}` } });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.authed(method, path, true);
    }
    if (res.status < 200 || res.status >= 300) {
      const err = this.parseErr(res.text);
      throw this.httpFailure(res, err);
    }
    return this.parseJson<T>(res);
  }

  private parseErr(text: string): string | undefined {
    try {
      return (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    } catch {
      return undefined;
    }
  }

  async listProxyHosts(): Promise<NpmProxyHost[]> {
    const rows = await this.authed<Array<Record<string, unknown>>>('GET', '/nginx/proxy-hosts?expand=certificate');
    return rows.map(normaliseHost);
  }

  async getProxyHost(id: number): Promise<NpmProxyHost> {
    return normaliseHost(await this.authed<Record<string, unknown>>('GET', `/nginx/proxy-hosts/${id}?expand=certificate`));
  }

  async listCertificates(): Promise<NpmCertificate[]> {
    return this.authed('GET', '/nginx/certificates');
  }

  async enableProxyHost(id: number): Promise<void> {
    await this.authed('POST', `/nginx/proxy-hosts/${id}/enable`);
  }

  async disableProxyHost(id: number): Promise<void> {
    await this.authed('POST', `/nginx/proxy-hosts/${id}/disable`);
  }
}

export interface NpmExpectationSpec {
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardHost: string;
  forwardPort: number;
  requireSsl: boolean;
  mustBeEnabled: boolean;
}

export interface NpmMismatch {
  field: string;
  expected: string;
  actual: string;
}

const CERT_MIN_DAYS = 7;

/** Compares the live proxy host with what the application expects. Pure. */
export function compareProxyHost(host: NpmProxyHost, exp: NpmExpectationSpec, now = new Date()): NpmMismatch[] {
  const out: NpmMismatch[] = [];
  const norm = (a: string[]) => [...a].map((d) => d.toLowerCase()).sort();
  const missing = norm(exp.domainNames).filter((d) => !norm(host.domain_names).includes(d));
  if (missing.length) out.push({ field: 'domain_names', expected: norm(exp.domainNames).join(','), actual: norm(host.domain_names).join(',') });
  if (host.forward_scheme !== exp.forwardScheme) out.push({ field: 'forward_scheme', expected: exp.forwardScheme, actual: host.forward_scheme });
  if (host.forward_host.toLowerCase() !== exp.forwardHost.toLowerCase())
    out.push({ field: 'forward_host', expected: exp.forwardHost, actual: host.forward_host });
  if (host.forward_port !== exp.forwardPort) out.push({ field: 'forward_port', expected: String(exp.forwardPort), actual: String(host.forward_port) });
  if (exp.mustBeEnabled && !host.enabled) out.push({ field: 'enabled', expected: 'true', actual: 'false' });
  if (exp.requireSsl) {
    if (!host.certificate_id || host.certificate_id === 'new') out.push({ field: 'certificate', expected: 'assigned', actual: 'none' });
    else if (host.certificate?.expires_on) {
      const days = (Date.parse(host.certificate.expires_on) - now.getTime()) / 86_400_000;
      if (days < CERT_MIN_DAYS)
        out.push({ field: 'certificate_expiry', expected: `> ${CERT_MIN_DAYS} days`, actual: days < 0 ? 'expired' : `${Math.floor(days)} days` });
    }
  }
  return out;
}

export function describeMismatch(m: NpmMismatch): string {
  return `${m.field} ${m.actual} ≠ expected ${m.expected}`;
}
