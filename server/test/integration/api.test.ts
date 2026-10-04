import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { SessionService } from '../../src/api/sessions.js';
import { hashPassword } from '../../src/security/password.js';
import { World } from '../helpers/world.js';

let w: World;
let app: FastifyInstance;
const PASSWORD = 'correct horse battery staple';

interface Session {
  cookie: string;
  csrf: string;
}

async function login(username: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { cookie, csrf: res.json().csrfToken };
}

const call = (s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, csrf = true) =>
  app.inject({ method, url, payload: payload as object, headers: { ...(s ? { cookie: s.cookie } : {}), ...(s && csrf ? { 'x-csrf-token': s.csrf } : {}) } });

let admin: Session;
let operator: Session;
let viewer: Session;

beforeAll(async () => {
  w = await new World(2).start();
  const hash = await hashPassword(PASSWORD);
  await w.t.db.query(`UPDATE users SET password_hash = $1`, [hash]);
  await w.t.db.query(`INSERT INTO users(username, password_hash, role) VALUES ('viewer', $1, 'viewer'), ('lockme', $1, 'viewer')`, [hash]);
  const sessions = new SessionService(w.t.db, 12, 30);
  app = await buildApp({ s: w.s, sessions, config: { FSM_COOKIE_SECURE: true, FSM_SESSION_TTL_HOURS: 12, NODE_ENV: 'test' }, loginRateLimit: 1000 });
  admin = await login('admin');
  operator = await login('operator');
  viewer = await login('viewer');
  await w.observe(2);
});
afterAll(async () => {
  await app?.close();
  await w?.stop();
});

describe('authentication and sessions', () => {
  it('sets a hardened session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: PASSWORD } });
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(res.json()).not.toHaveProperty('user.passwordHash');
  });

  it('rejects bad credentials with a generic message and audits the attempt', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong password!' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong password!' } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.json().message).toBe(bad.json().message);
    const ev = await w.s.audit.query({ category: ['auth'], q: 'Failed login' });
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain('wrong password!');
  });

  it('rate-limits login attempts per client', async () => {
    const limited = await buildApp({ s: w.s, sessions: new SessionService(w.t.db, 12, 30), config: { FSM_COOKIE_SECURE: true, FSM_SESSION_TTL_HOURS: 12, NODE_ENV: 'test' }, loginRateLimit: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'x' } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });

  it('locks an account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lockme', password: 'nope nope nope' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lockme', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    const { rows } = await w.t.db.query(`SELECT locked_until FROM users WHERE username = 'lockme'`);
    expect(rows[0].locked_until).not.toBeNull();
  });

  it('requires a session', async () => {
    expect((await call(null, 'GET', '/api/system/status')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie: 'fsm_session=forged' } })).statusCode).toBe(401);
  });

  it('requires a CSRF token on state-changing requests', async () => {
    const res = await call(operator, 'POST', '/api/failover/test', { targetSiteId: w.siteB.id }, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
    const wrong = await app.inject({ method: 'POST', url: '/api/failover/test', payload: { targetSiteId: w.siteB.id }, headers: { cookie: operator.cookie, 'x-csrf-token': 'x'.repeat(43) } });
    expect(wrong.statusCode).toBe(403);
  });

  it('logout invalidates the session', async () => {
    const s = await login('viewer');
    expect((await call(s, 'POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('sets security headers', async () => {
    const res = await call(viewer, 'GET', '/api/auth/me');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('RBAC', () => {
  it('viewers can read but not act', async () => {
    expect((await call(viewer, 'GET', '/api/system/status')).statusCode).toBe(200);
    expect((await call(viewer, 'POST', '/api/failover/test', { targetSiteId: w.siteB.id })).statusCode).toBe(403);
    expect((await call(viewer, 'POST', '/api/monitoring/pause')).statusCode).toBe(403);
  });

  it('operators can run tests but not change configuration or users', async () => {
    expect((await call(operator, 'POST', '/api/failover/test', { targetSiteId: w.siteB.id })).statusCode).toBe(202);
    expect((await call(operator, 'POST', '/api/sites', { code: 'C', name: 'C', designatedRole: 'secondary' })).statusCode).toBe(403);
    expect((await call(operator, 'GET', '/api/users')).statusCode).toBe(403);
    await w.s.orchestrator.waitAll();
  });

  it('operators cannot override failover safety checks', async () => {
    const res = await call(operator, 'POST', '/api/failover/execute', { targetSiteId: w.siteB.id, confirm: 'FAILOVER TO SITE B', acknowledge: ['primary.reachable'], reason: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/Only administrators/);
  });

  it('admins cannot lock themselves out', async () => {
    const me = (await call(admin, 'GET', '/api/auth/me')).json().user;
    expect((await call(admin, 'PATCH', `/api/users/${me.id}`, { role: 'viewer' })).statusCode).toBe(409);
    expect((await call(admin, 'DELETE', `/api/users/${me.id}`)).statusCode).toBe(409);
  });
});

describe('credentials are never exposed', () => {
  it('write-only secrets on create, list and audit', async () => {
    const secret = 'super-secret-proxmox-token-value';
    const res = await call(admin, 'POST', '/api/proxmox-instances', { siteId: w.siteB.id, name: 'pve-b2', baseUrl: w.pveB.url, tokenId: 'fsm@pve!other', tokenSecret: secret });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ tokenSecretConfigured: true });
    expect(res.body).not.toContain(secret);
    for (const url of ['/api/proxmox-instances', '/api/npm-instances', '/api/cloudflare-accounts', '/api/system/status', '/api/events?limit=500']) {
      const body = (await call(admin, 'GET', url)).body;
      expect(body).not.toContain(secret);
      expect(body).not.toContain(w.cf.token);
      expect(body).not.toContain(w.npmB.secret);
      expect(body).not.toContain(w.pveB.tokenSecret);
    }
    // The extra instance has a token the fake rejects; remove it so it does not block later failovers.
    expect((await call(admin, 'DELETE', `/api/proxmox-instances/${res.json().id}`)).statusCode).toBe(200);
  });

  it('rejects requests with credentials over the wrong role', async () => {
    expect((await call(operator, 'PATCH', `/api/cloudflare-accounts/${(await w.s.repos.cloudflareAccounts.list())[0]!.id}`, { apiToken: 'stolen-token-xyz' })).statusCode).toBe(403);
  });
});

describe('dashboard and readiness', () => {
  it('returns the full dashboard in one call', async () => {
    const res = await call(viewer, 'GET', '/api/system/status');
    const body = res.json();
    expect(body.controller.failoverState).toBe('HEALTHY_PRIMARY');
    expect(body.sites.map((x: { code: string; active: boolean }) => [x.code, x.active])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(body.readiness.question).toMatch(/If Site A disappeared right now, can I safely move production to Site B\?/);
    expect(body.readiness.ready).toBe(true);
    expect(body.applications[0].replication.safety).toBe('SAFE');
    expect(body.cloudflare.status).toBe('CONNECTED');
  });

  it('prepare returns blockers and the confirmation phrase', async () => {
    const res = await call(operator, 'POST', '/api/failover/prepare', { targetSiteId: w.siteB.id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.confirmationPhrase).toBe('FAILOVER TO SITE B');
    expect(body.overridable).toEqual(['primary.reachable']);
  });
});

describe('configuration safety', () => {
  it('validates health check configuration', async () => {
    const res = await call(admin, 'POST', '/api/health-checks', { name: 'x', siteId: w.siteA.id, category: 'network', type: 'tcp', independenceGroup: 'tcp', config: { host: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/port/);
  });

  it('refuses to manage a DNS record whose content matches neither target', async () => {
    const zone = (await w.s.repos.zones.list())[0]!;
    const rec = w.cf.addRecord({ name: 'blog.example.com', type: 'CNAME', content: 'elsewhere.example.net', ttl: 1, proxied: true });
    const res = await call(admin, 'POST', `/api/applications/${w.apps[0]!.id}/dns-records`, { zoneId: zone.id, recordId: rec.id, primaryContent: 'a.cfargotunnel.com', secondaryContent: 'b.cfargotunnel.com' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/matches neither target/);
  });

  it('lists discovered DNS records with their owning application', async () => {
    const zone = (await w.s.repos.zones.list())[0]!;
    const res = await call(admin, 'GET', `/api/cloudflare-zones/${zone.id}/records`);
    const recs = res.json();
    expect(recs.find((r: { name: string }) => r.name === 'www.example.com').managedBy).toBe(w.apps[0]!.id);
  });

  it('registers a workload using the name Proxmox reports', async () => {
    w.pveB.guests.push({ vmid: 250, name: 'extra-b', status: 'stopped', kind: 'qemu' });
    const inst = (await w.s.repos.proxmox.list({ siteId: w.siteB.id }))[0]!;
    const res = await call(admin, 'POST', `/api/applications/${w.apps[0]!.id}/workloads`, { siteId: w.siteB.id, proxmoxInstanceId: inst.id, node: 'pve-b', vmid: 250 });
    expect(res.statusCode).toBe(201);
    expect(res.json().expectedName).toBe('extra-b');
    expect(res.json().allowStart).toBe(false); // explicit opt-in required
    expect((await call(admin, 'POST', `/api/applications/${w.apps[0]!.id}/workloads`, { siteId: w.siteB.id, proxmoxInstanceId: inst.id, node: 'pve-b', vmid: 999 })).statusCode).toBe(502);
    await call(admin, 'DELETE', `/api/applications/${w.apps[0]!.id}/workloads/${res.json().id}`);
  });

  it('does not allow enabling automatic failover in Phase 1', async () => {
    expect((await call(admin, 'PUT', '/api/policies/active', { automaticFailover: true })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/policies/active', { consecutiveFailures: 3 })).json().consecutiveFailures).toBe(3);
    await call(admin, 'PUT', '/api/policies/active', { consecutiveFailures: 2 });
  });

  it('later-phase endpoints answer 501', async () => {
    expect((await call(operator, 'POST', '/api/failback/execute')).statusCode).toBe(501);
    expect((await call(operator, 'POST', '/api/maintenance/enable')).statusCode).toBe(501);
  });
});

describe('events and OpenAPI', () => {
  it('searches and filters events', async () => {
    const res = await call(viewer, 'GET', '/api/events?category=auth&q=logged');
    expect(res.statusCode).toBe(200);
    expect(res.json().every((e: { category: string }) => e.category === 'auth')).toBe(true);
    expect((await call(viewer, 'GET', '/api/events?severity=BOGUS')).statusCode).toBe(400);
  });

  it('publishes OpenAPI documentation', async () => {
    const res = await call(viewer, 'GET', '/api/openapi.json');
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3/);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/failover/execute', '/api/sites/{id}/health', '/api/events', '/api/system/status']));
  });
});

describe('failover through the API', () => {
  it('refuses with 422 and blockers, then fails over after Site A is confirmed down', async () => {
    const refused = await call(operator, 'POST', '/api/failover/execute', { targetSiteId: w.siteB.id, confirm: 'FAILOVER TO SITE B' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().details.blockers[0].key).toBe('primary.reachable');

    await w.killSiteA();
    await w.observe(3);
    const res = await call(operator, 'POST', '/api/failover/execute', { targetSiteId: w.siteB.id, confirm: 'FAILOVER TO SITE B' });
    expect(res.statusCode).toBe(202);
    await w.s.orchestrator.wait(res.json().id);
    const op = (await call(viewer, 'GET', `/api/operations/${res.json().id}`)).json();
    expect(op.status).toBe('succeeded');
    expect(op.steps.length).toBeGreaterThan(10);
    const status = (await call(viewer, 'GET', '/api/failover/status')).json();
    expect(status.controller.failoverState).toBe('SECONDARY_ACTIVE');
    expect((await call(operator, 'POST', '/api/failover/cancel')).statusCode).toBe(409);
  });
});
