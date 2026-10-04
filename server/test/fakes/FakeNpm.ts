import { FakeServer, type FakeRequest, type FakeResponse } from './FakeServer.js';

export interface FakeProxyHost {
  id: number;
  domain_names: string[];
  forward_scheme: 'http' | 'https';
  forward_host: string;
  forward_port: number;
  enabled: 0 | 1;
  certificate_id: number | null;
  ssl_forced: 0 | 1;
}

/** Stateful fake of the subset of the Nginx Proxy Manager API FSM uses. */
export class FakeNpm extends FakeServer {
  identity = 'fsm@example.com';
  secret = 'npm-password-123456';
  hosts: FakeProxyHost[] = [];
  certificates = [{ id: 1, nice_name: 'example.com', domain_names: ['*.example.com', 'example.com'], expires_on: new Date(Date.now() + 60 * 86_400_000).toISOString() }];
  private issued = new Set<string>();
  logins = 0;

  constructor() {
    super((req) => this.route(req));
  }

  addHost(h: Omit<FakeProxyHost, 'id' | 'enabled' | 'certificate_id' | 'ssl_forced'> & Partial<FakeProxyHost>): FakeProxyHost {
    const host: FakeProxyHost = { id: this.hosts.length + 1, enabled: 1, certificate_id: 1, ssl_forced: 1, ...h };
    this.hosts.push(host);
    return host;
  }

  /** Invalidate all issued tokens (simulates NPM restart / expiry). */
  revokeTokens(): void {
    this.issued.clear();
  }

  private route(req: FakeRequest): FakeResponse {
    const p = req.path.replace(/^\/api/, '') || '/';
    if (p === '/' && req.method === 'GET') return { body: { status: 'OK', version: { major: 2, minor: 11, revision: 3 } } };
    if (p === '/tokens' && req.method === 'POST') {
      const b = req.json<{ identity: string; secret: string }>();
      if (b.identity !== this.identity || b.secret !== this.secret) return { status: 401, body: { error: { code: 401, message: 'Invalid password' } } };
      this.logins++;
      const token = `npm-jwt-${this.logins}-abcdef`;
      this.issued.add(token);
      return { body: { token, expires: new Date(Date.now() + 86_400_000).toISOString() } };
    }
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    if (!auth || !this.issued.has(auth)) return { status: 401, body: { error: { code: 401, message: 'Token has expired' } } };
    const withCert = (h: FakeProxyHost) => ({ ...h, certificate: this.certificates.find((c) => c.id === h.certificate_id) ?? null });
    let m: RegExpMatchArray | null;
    if (p === '/nginx/proxy-hosts') return { body: this.hosts.map(withCert) };
    if (p === '/nginx/certificates') return { body: this.certificates };
    if ((m = p.match(/^\/nginx\/proxy-hosts\/(\d+)(\/(enable|disable))?$/))) {
      const h = this.hosts.find((x) => x.id === Number(m![1]));
      if (!h) return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
      if (m[3] && req.method === 'POST') {
        h.enabled = m[3] === 'enable' ? 1 : 0;
        return { body: true };
      }
      return { body: withCert(h) };
    }
    return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
  }
}
