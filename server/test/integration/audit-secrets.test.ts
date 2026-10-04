import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { createRepos } from '../../src/repos/index.js';
import { SecretBox } from '../../src/security/secretBox.js';
import { SecretStore } from '../../src/security/secretStore.js';
import { SYSTEM_ACTOR } from '../../src/domain/types.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

let t: TestDb;
let secrets: SecretStore;
let audit: AuditLog;

beforeAll(async () => {
  t = await createTestDb();
  secrets = new SecretStore(t.db, new SecretBox(Buffer.alloc(32, 9)));
  audit = new AuditLog(t.db, () => secrets.knownValues());
});
afterAll(() => t.close());

describe('SecretStore', () => {
  it('stores only ciphertext and decrypts on demand', async () => {
    const id = await secrets.put('cloudflare.api_token', 'cf-super-secret-token');
    const raw = await t.db.query('SELECT ciphertext FROM secrets WHERE id = $1', [id]);
    expect(raw.rows[0].ciphertext.toString('utf8')).not.toContain('cf-super-secret-token');
    const fresh = new SecretStore(t.db, new SecretBox(Buffer.alloc(32, 9)));
    expect(await fresh.get(id, 'cloudflare.api_token')).toBe('cf-super-secret-token');
  });

  it('replaces a secret in place', async () => {
    const id = await secrets.put('npm.password', 'first-password');
    expect(await secrets.put('npm.password', 'second-password', id)).toBe(id);
    const fresh = new SecretStore(t.db, new SecretBox(Buffer.alloc(32, 9)));
    expect(await fresh.get(id, 'npm.password')).toBe('second-password');
  });

  it('warms the redaction cache from the database', async () => {
    const fresh = new SecretStore(t.db, new SecretBox(Buffer.alloc(32, 9)));
    await fresh.warm();
    expect(fresh.knownValues()).toContain('cf-super-secret-token');
  });
});

describe('AuditLog', () => {
  it('redacts known secrets from messages and details', async () => {
    const ev = await audit.write({
      severity: 'ERROR',
      category: 'provider',
      action: 'cloudflare.error',
      message: 'call failed with token cf-super-secret-token',
      actor: SYSTEM_ACTOR,
      details: { apiToken: 'cf-super-secret-token', note: 'Bearer abc.def' },
    });
    expect(ev.message).not.toContain('cf-super-secret-token');
    expect(JSON.stringify(ev.details)).not.toContain('cf-super-secret-token');
    expect(JSON.stringify(ev.details)).not.toContain('abc.def');
  });

  it('searches and filters', async () => {
    await audit.write({ severity: 'WARNING', category: 'health', action: 'check.failed', message: 'Site A HTTP health check failed', actor: SYSTEM_ACTOR });
    await audit.write({ severity: 'CRITICAL', category: 'failover', action: 'site.confirmed_failed', message: 'Site A confirmed failed', actor: SYSTEM_ACTOR });
    await audit.write({ severity: 'INFO', category: 'auth', action: 'login', message: 'admin logged in', actor: { type: 'user', id: '00000000-0000-0000-0000-000000000001', name: 'admin', ip: '10.0.0.5' } });

    expect((await audit.query({ q: 'confirmed' })).map((e) => e.action)).toEqual(['site.confirmed_failed']);
    expect((await audit.query({ q: 'HTT' })).map((e) => e.action)).toEqual(['check.failed']);
    expect((await audit.query({ severity: ['CRITICAL', 'WARNING'] })).length).toBe(2);
    expect((await audit.query({ category: ['auth'] }))[0]!.ip).toBe('10.0.0.5');
    const all = await audit.query({ limit: 2 });
    expect(all).toHaveLength(2);
    const older = await audit.query({ before: all[1]!.id });
    expect(older.every((e) => e.id < all[1]!.id)).toBe(true);
  });

  it('notifies listeners', async () => {
    const seen: string[] = [];
    const off = audit.onEvent((e) => seen.push(e.action));
    await audit.write({ severity: 'INFO', category: 'system', action: 'x', message: 'y', actor: SYSTEM_ACTOR });
    off();
    expect(seen).toEqual(['x']);
  });
});

describe('repositories', () => {
  it('creates, updates, lists and deletes with camelCase mapping', async () => {
    const repos = createRepos(t.db);
    const site = await repos.sites.create({ code: 'A', name: 'Site A', designatedRole: 'primary' });
    expect(site.designatedRole).toBe('primary');
    const upd = await repos.sites.update(site.id, { description: 'Primary DC' });
    expect(upd!.description).toBe('Primary DC');
    expect((await repos.sites.list({ code: 'A' }))).toHaveLength(1);
    const check = await repos.healthChecks.create({
      name: 'ping', siteId: site.id, category: 'network', type: 'icmp', path: 'sdwan', independenceGroup: 'icmp', config: { host: '10.1.0.1' },
    });
    expect(check.config).toEqual({ host: '10.1.0.1' });
    expect(await repos.sites.get('not-a-uuid')).toBeNull();
    expect(await repos.healthChecks.delete(check.id)).toBe(true);
  });
});
