import type { HttpResponse } from '../../http/client.js';
import { JsonApiProvider, type ProviderOptions } from '../base.js';
import { ProviderError } from '../errors.js';

export interface CfZone {
  id: string;
  name: string;
  status: string;
}

export type CfRecordType = 'A' | 'AAAA' | 'CNAME' | string;

export interface CfDnsRecord {
  id: string;
  zone_id?: string;
  name: string;
  type: CfRecordType;
  content: string;
  ttl: number;
  proxied: boolean;
}

export interface CfTunnel {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'inactive' | string;
  connections: Array<{ colo_name?: string; is_pending_reconnect?: boolean; id?: string }>;
}

export interface CfTunnelConfig {
  source: 'cloudflare' | 'local' | string;
  ingress: Array<{ hostname?: string; service: string }>;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

export class CloudflareProvider extends JsonApiProvider {
  protected readonly name = 'cloudflare' as const;

  constructor(
    opts: ProviderOptions,
    private readonly apiToken: string,
  ) {
    super(opts);
  }

  protected secretValues(): string[] {
    return [this.apiToken];
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, json?: unknown): Promise<CfEnvelope<T>> {
    const res = await this.send({ method, path, json, headers: { authorization: `Bearer ${this.apiToken}` } });
    return this.unwrap<T>(res);
  }

  private unwrap<T>(res: HttpResponse): CfEnvelope<T> {
    let body: CfEnvelope<T> | undefined;
    try {
      body = JSON.parse(res.text) as CfEnvelope<T>;
    } catch {
      /* handled below */
    }
    if (res.status >= 200 && res.status < 300 && body?.success) return body;
    const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
    if (!body && res.status >= 200 && res.status < 300) {
      throw new ProviderError(`Cloudflare API returned invalid JSON (HTTP ${res.status})`, 'cloudflare', {
        status: res.status,
        kind: 'invalid_response',
      });
    }
    throw this.httpFailure(res.status >= 200 && res.status < 300 ? { ...res, status: 400 } : res, detail);
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 100; page++) {
      const env = await this.call<T[]>('GET', `${path}${sep}page=${page}&per_page=100`);
      out.push(...env.result);
      if (!env.result_info || page >= env.result_info.total_pages) break;
    }
    return out;
  }

  /** Verifies the token is active. Supports user-owned and account-owned tokens. */
  async verifyToken(accountId?: string): Promise<{ status: string }> {
    try {
      return (await this.call<{ status: string }>('GET', '/user/tokens/verify')).result;
    } catch (err) {
      if (accountId && err instanceof ProviderError && err.kind === 'auth') {
        return (await this.call<{ status: string }>('GET', `/accounts/${encodeURIComponent(accountId)}/tokens/verify`)).result;
      }
      throw err;
    }
  }

  listZones(): Promise<CfZone[]> {
    return this.paginate<CfZone>('/zones');
  }

  listDnsRecords(zoneId: string, filter: { name?: string; type?: string } = {}): Promise<CfDnsRecord[]> {
    const q = new URLSearchParams();
    if (filter.name) q.set('name', filter.name);
    if (filter.type) q.set('type', filter.type);
    const qs = q.toString();
    return this.paginate<CfDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records${qs ? `?${qs}` : ''}`);
  }

  async getDnsRecord(zoneId: string, recordId: string): Promise<CfDnsRecord> {
    return (await this.call<CfDnsRecord>('GET', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`)).result;
  }

  async createDnsRecord(
    zoneId: string,
    rec: { type: CfRecordType; name: string; content: string; ttl: number; proxied: boolean },
  ): Promise<CfDnsRecord> {
    return (await this.call<CfDnsRecord>('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, rec)).result;
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    patch: { content: string; ttl: number; proxied: boolean },
  ): Promise<CfDnsRecord> {
    return (
      await this.call<CfDnsRecord>('PATCH', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, patch)
    ).result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call('DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
  }

  async getTunnel(accountId: string, tunnelId: string): Promise<CfTunnel> {
    const t = (await this.call<CfTunnel>('GET', `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`)).result;
    return { ...t, connections: t.connections ?? [] };
  }

  async getTunnelConfig(accountId: string, tunnelId: string): Promise<CfTunnelConfig> {
    const r = (
      await this.call<{ source?: string; config?: { ingress?: CfTunnelConfig['ingress'] } | null }>(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      )
    ).result;
    return { source: r.source ?? 'cloudflare', ingress: r.config?.ingress ?? [] };
  }
}

/** Hostname match for tunnel ingress rules, including "*.example.com" wildcards. */
export function ingressCovers(ingress: CfTunnelConfig['ingress'], hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ingress.some((rule) => {
    if (!rule.hostname || rule.service.startsWith('http_status:')) return false;
    const r = rule.hostname.toLowerCase();
    if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.split('.').length === r.split('.').length;
    return r === h;
  });
}

/** CNAME content Cloudflare expects for a tunnel. */
export const tunnelCname = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;
