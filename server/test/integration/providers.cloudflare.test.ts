import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudflareProvider, ingressCovers } from '../../src/providers/cloudflare/CloudflareProvider.js';
import { ProviderError } from '../../src/providers/errors.js';
import { FakeCloudflare } from '../fakes/FakeCloudflare.js';
import { testHttp } from '../helpers/http.js';

const cf = new FakeCloudflare();
const http = testHttp();
let provider: CloudflareProvider;

beforeAll(async () => {
  await cf.start();
  provider = new CloudflareProvider({ http, baseUrl: `${cf.url}/client/v4`, retryDelayMs: 5 }, cf.token);
});
afterAll(async () => {
  await cf.stop();
  await http.close();
});
beforeEach(() => {
  cf.clearFaults();
  cf.records = [];
  cf.pageSize = 100;
});

describe('CloudflareProvider', () => {
  it('verifies the token', async () => {
    expect((await provider.verifyToken()).status).toBe('active');
  });

  it('reports a bad token as an auth error without leaking the token', async () => {
    const bad = new CloudflareProvider({ http, baseUrl: `${cf.url}/client/v4` }, 'wrong-token-abcdef');
    const err = (await bad.verifyToken().catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('wrong-token-abcdef');
  });

  it('discovers zones and paginates DNS records', async () => {
    cf.pageSize = 2;
    for (let i = 0; i < 5; i++) cf.addRecord({ name: `h${i}.example.com`, type: 'CNAME', content: 'x', ttl: 1, proxied: true });
    expect(await provider.listZones()).toEqual([{ id: 'zone1', name: 'example.com', status: 'active' }]);
    const recs = await provider.listDnsRecords('zone1');
    expect(recs).toHaveLength(5);
    expect(cf.countRequests('GET', /dns_records$/)).toBeGreaterThanOrEqual(3);
  });

  it('filters records by name', async () => {
    cf.addRecord({ name: 'app.example.com', type: 'CNAME', content: 'a', ttl: 1, proxied: true });
    cf.addRecord({ name: 'www.example.com', type: 'CNAME', content: 'a', ttl: 1, proxied: true });
    const recs = await provider.listDnsRecords('zone1', { name: 'app.example.com' });
    expect(recs.map((r) => r.name)).toEqual(['app.example.com']);
  });

  it('creates, reads, updates and deletes a record', async () => {
    const created = await provider.createDnsRecord('zone1', { type: 'CNAME', name: 'new.example.com', content: 'a.cfargotunnel.com', ttl: 1, proxied: true });
    expect((await provider.getDnsRecord('zone1', created.id)).content).toBe('a.cfargotunnel.com');
    const updated = await provider.updateDnsRecord('zone1', created.id, { content: 'b.cfargotunnel.com', ttl: 1, proxied: true });
    expect(updated.content).toBe('b.cfargotunnel.com');
    await provider.deleteDnsRecord('zone1', created.id);
    await expect(provider.getDnsRecord('zone1', created.id)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('retries reads on 5xx and 429, then succeeds', async () => {
    cf.fault({ method: 'GET', path: /\/zones$/, status: 503, times: 1 }).fault({ method: 'GET', path: /\/zones$/, status: 429, times: 1 });
    expect(await provider.listZones()).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    cf.fault({ method: 'GET', path: /\/zones$/, status: 500 });
    await expect(provider.listZones()).rejects.toMatchObject({ kind: 'server', retryable: true });
  });

  it('never retries mutations', async () => {
    const rec = cf.addRecord({ name: 'app.example.com', type: 'CNAME', content: 'a', ttl: 1, proxied: true });
    cf.fault({ method: 'PATCH', status: 502, times: 1 });
    const before = cf.countRequests('PATCH', /dns_records/);
    await expect(provider.updateDnsRecord('zone1', rec.id, { content: 'b', ttl: 1, proxied: true })).rejects.toBeInstanceOf(ProviderError);
    expect(cf.countRequests('PATCH', /dns_records/)).toBe(before + 1);
    expect(cf.record('app.example.com')!.content).toBe('a');
  });

  it('treats a dropped connection as a retryable network error', async () => {
    cf.fault({ path: /\/zones$/, drop: true });
    await expect(provider.listZones()).rejects.toMatchObject({ kind: 'network' });
  });

  it('rejects malformed JSON', async () => {
    cf.fault({ path: /\/zones$/, status: 200, rawBody: '<html>oops</html>' });
    await expect(provider.listZones()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('reports success:false bodies as errors', async () => {
    cf.fault({ path: /\/zones$/, status: 200, body: { success: false, errors: [{ code: 9109, message: 'Invalid access token' }], result: null } });
    await expect(provider.listZones()).rejects.toThrow(/9109/);
  });

  it('reads tunnel status and remote ingress', async () => {
    cf.addTunnel('tun-b', 'site-b', ['app.example.com', '*.wild.example.com']);
    const t = await provider.getTunnel(cf.accountId, 'tun-b');
    expect(t.status).toBe('healthy');
    expect(t.connections).toHaveLength(1);
    const cfg = await provider.getTunnelConfig(cf.accountId, 'tun-b');
    expect(ingressCovers(cfg.ingress, 'app.example.com')).toBe(true);
    expect(ingressCovers(cfg.ingress, 'x.wild.example.com')).toBe(true);
    expect(ingressCovers(cfg.ingress, 'a.b.wild.example.com')).toBe(false);
    expect(ingressCovers(cfg.ingress, 'other.example.com')).toBe(false);
  });
});
