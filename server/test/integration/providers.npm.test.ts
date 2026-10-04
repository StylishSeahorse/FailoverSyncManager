import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compareProxyHost, NpmProvider } from '../../src/providers/npm/NpmProvider.js';
import { FakeNpm } from '../fakes/FakeNpm.js';
import { testHttp } from '../helpers/http.js';

const npm = new FakeNpm();
const http = testHttp();
let provider: NpmProvider;

beforeAll(async () => {
  await npm.start();
  provider = new NpmProvider({ http, baseUrl: npm.url, retryDelayMs: 5 }, npm.identity, npm.secret);
});
afterAll(async () => {
  await npm.stop();
  await http.close();
});
beforeEach(() => {
  npm.clearFaults();
  npm.hosts = [];
  npm.addHost({ domain_names: ['app.example.com'], forward_scheme: 'http', forward_host: '10.2.0.20', forward_port: 80 });
});

const expectation = {
  domainNames: ['app.example.com'],
  forwardScheme: 'http' as const,
  forwardHost: '10.2.0.20',
  forwardPort: 80,
  requireSsl: true,
  mustBeEnabled: true,
};

describe('NpmProvider', () => {
  it('reads the unauthenticated status', async () => {
    expect((await provider.status()).status).toBe('OK');
  });

  it('logs in, caches the token and lists proxy hosts with certificates', async () => {
    const before = npm.logins;
    const hosts = await provider.listProxyHosts();
    await provider.listCertificates();
    expect(hosts[0]).toMatchObject({ forward_host: '10.2.0.20', enabled: true });
    expect(hosts[0]!.certificate?.nice_name).toBe('example.com');
    expect(npm.logins - before).toBeLessThanOrEqual(1);
  });

  it('re-authenticates once when the token is revoked', async () => {
    await provider.listProxyHosts();
    npm.revokeTokens();
    const before = npm.logins;
    await provider.listProxyHosts();
    expect(npm.logins).toBe(before + 1);
  });

  it('fails clearly on bad credentials without leaking them', async () => {
    const bad = new NpmProvider({ http, baseUrl: npm.url }, npm.identity, 'bad-password-xyz');
    const err = await bad.listProxyHosts().catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('bad-password-xyz');
  });

  it('enables and disables a proxy host', async () => {
    await provider.disableProxyHost(1);
    expect((await provider.getProxyHost(1)).enabled).toBe(false);
    await provider.enableProxyHost(1);
    expect((await provider.getProxyHost(1)).enabled).toBe(true);
  });

  it('matches a correct configuration', async () => {
    const [host] = await provider.listProxyHosts();
    expect(compareProxyHost(host!, expectation)).toEqual([]);
  });

  it('detects upstream, scheme, enabled and certificate mismatches', async () => {
    npm.hosts[0]!.forward_host = '10.2.0.99';
    npm.hosts[0]!.enabled = 0;
    npm.certificates[0]!.expires_on = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const [host] = await provider.listProxyHosts();
    const fields = compareProxyHost(host!, expectation).map((m) => m.field);
    expect(fields).toEqual(['forward_host', 'enabled', 'certificate_expiry']);
    npm.certificates[0]!.expires_on = new Date(Date.now() + 60 * 86_400_000).toISOString();
  });

  it('detects a missing domain and missing certificate', async () => {
    npm.hosts[0]!.certificate_id = null;
    const [host] = await provider.listProxyHosts();
    const fields = compareProxyHost(host!, { ...expectation, domainNames: ['app.example.com', 'www.example.com'] }).map((m) => m.field);
    expect(fields).toEqual(['domain_names', 'certificate']);
  });

  it('surfaces NPM server errors', async () => {
    npm.fault({ path: /proxy-hosts/, status: 500, body: { error: { message: 'db locked' } } });
    await expect(provider.listProxyHosts()).rejects.toThrow(/HTTP 500/);
  });
});
