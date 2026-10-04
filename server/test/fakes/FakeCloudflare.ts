import { randomUUID } from 'node:crypto';
import { FakeServer, type FakeRequest, type FakeResponse } from './FakeServer.js';

export interface FakeCfRecord {
  id: string;
  zone_id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

export interface FakeCfTunnel {
  id: string;
  name: string;
  status: string;
  connections: Array<{ colo_name: string; id: string }>;
  config: { source: string; ingress: Array<{ hostname?: string; service: string }> } | null;
}

const ok = (result: unknown, info?: unknown): FakeResponse => ({
  body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) },
});
const fail = (status: number, code: number, message: string): FakeResponse => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

/** Stateful fake of the subset of the Cloudflare v4 API FSM uses. */
export class FakeCloudflare extends FakeServer {
  token = 'cf-test-token-0123456789';
  accountId = 'acc123';
  zones = [{ id: 'zone1', name: 'example.com', status: 'active' }];
  records: FakeCfRecord[] = [];
  tunnels = new Map<string, FakeCfTunnel>();
  /** Page size for list endpoints, to exercise pagination. */
  pageSize = 100;

  constructor() {
    super((req) => this.route(req));
  }

  addRecord(r: Omit<FakeCfRecord, 'id' | 'zone_id'> & { zone_id?: string; id?: string }): FakeCfRecord {
    const rec = { id: r.id ?? randomUUID().replace(/-/g, ''), zone_id: r.zone_id ?? 'zone1', ...r } as FakeCfRecord;
    this.records.push(rec);
    return rec;
  }

  addTunnel(id: string, name: string, hostnames: string[], status = 'healthy'): FakeCfTunnel {
    const t: FakeCfTunnel = {
      id,
      name,
      status,
      connections: status === 'healthy' ? [{ colo_name: 'LHR', id: randomUUID() }] : [],
      config: { source: 'cloudflare', ingress: [...hostnames.map((h) => ({ hostname: h, service: 'https://npm:443' })), { service: 'http_status:404' }] },
    };
    this.tunnels.set(id, t);
    return t;
  }

  record(name: string): FakeCfRecord | undefined {
    return this.records.find((r) => r.name === name);
  }

  private page<T>(items: T[], req: FakeRequest): FakeResponse {
    const per = Math.min(Number(req.query.get('per_page') ?? this.pageSize), this.pageSize);
    const page = Number(req.query.get('page') ?? 1);
    const total_pages = Math.max(1, Math.ceil(items.length / per));
    return ok(items.slice((page - 1) * per, page * per), { page, per_page: per, total_pages, count: items.length, total_count: items.length });
  }

  private route(req: FakeRequest): FakeResponse {
    if (req.headers.authorization !== `Bearer ${this.token}`) return fail(403, 10000, 'Authentication error');
    const p = req.path.replace(/^\/client\/v4/, '');
    let m: RegExpMatchArray | null;
    if (p === '/user/tokens/verify') return ok({ id: 'tok', status: 'active' });
    if (p === '/zones' && req.method === 'GET') return this.page(this.zones, req);
    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zone = m[1]!;
      if (!this.zones.some((z) => z.id === zone)) return fail(404, 7003, 'Could not route');
      if (req.method === 'GET') {
        let list = this.records.filter((r) => r.zone_id === zone);
        const name = req.query.get('name');
        const type = req.query.get('type');
        if (name) list = list.filter((r) => r.name === name);
        if (type) list = list.filter((r) => r.type === type);
        return this.page(list, req);
      }
      if (req.method === 'POST') {
        const b = req.json<Omit<FakeCfRecord, 'id' | 'zone_id'>>();
        return ok(this.addRecord({ ...b, zone_id: zone }));
      }
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/))) {
      const rec = this.records.find((r) => r.zone_id === m![1] && r.id === m![2]);
      if (!rec) return fail(404, 81044, 'Record does not exist.');
      if (req.method === 'GET') return ok(rec);
      if (req.method === 'PATCH') {
        Object.assign(rec, req.json<Partial<FakeCfRecord>>());
        return ok(rec);
      }
      if (req.method === 'DELETE') {
        this.records = this.records.filter((r) => r !== rec);
        return ok({ id: rec.id });
      }
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)(\/configurations)?$/))) {
      if (m[1] !== this.accountId) return fail(403, 10000, 'Authentication error');
      const t = this.tunnels.get(m[2]!);
      if (!t) return fail(404, 1003, 'Tunnel not found');
      if (m[3]) return ok({ tunnel_id: t.id, source: t.config?.source ?? 'local', config: t.config ? { ingress: t.config.ingress } : null });
      return ok({ id: t.id, name: t.name, status: t.status, connections: t.connections });
    }
    return fail(404, 7000, `No route for ${req.method} ${p}`);
  }
}
