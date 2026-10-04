import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/errors.js';
import { ProxmoxProvider } from '../../src/providers/proxmox/ProxmoxProvider.js';
import { FakeProxmox } from '../fakes/FakeProxmox.js';
import { testHttp } from '../helpers/http.js';

const pve = new FakeProxmox('pve-b');
const http = testHttp();
let provider: ProxmoxProvider;

beforeAll(async () => {
  await pve.start();
  provider = new ProxmoxProvider({ http, baseUrl: pve.url, retryDelayMs: 5 }, pve.tokenId, pve.tokenSecret);
});
afterAll(async () => {
  await pve.stop();
  await http.close();
});
beforeEach(() => {
  pve.clearFaults();
  pve.nodeStatus = 'online';
  pve.guests = [
    { vmid: 220, name: 'wordpress-b', status: 'stopped', kind: 'qemu' },
    { vmid: 230, name: 'nextcloud-b', status: 'running', kind: 'lxc' },
  ];
});

describe('ProxmoxProvider', () => {
  it('authenticates with an API token and lists nodes', async () => {
    expect((await provider.version()).version).toBe('8.2.4');
    expect((await provider.listNodes())[0]).toMatchObject({ node: 'pve-b', status: 'online' });
  });

  it('reports a bad token as auth failure without leaking the secret', async () => {
    const bad = new ProxmoxProvider({ http, baseUrl: pve.url }, pve.tokenId, 'nope-nope-nope');
    const err = (await bad.listNodes().catch((e) => e)) as ProviderError;
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('nope-nope-nope');
  });

  it('reads node status and resources', async () => {
    const s = await provider.nodeStatus('pve-b');
    expect(s.cpu).toBeCloseTo(0.12);
    expect(s.memory.total).toBe(16e9);
  });

  it('lists qemu and lxc guests', async () => {
    const guests = await provider.listGuests('pve-b');
    expect(guests.map((g) => [g.vmid, g.kind, g.status])).toEqual([
      [220, 'qemu', 'stopped'],
      [230, 'lxc', 'running'],
    ]);
  });

  it('starts a VM and waits for the task', async () => {
    const upid = await provider.powerAction('pve-b', 220, 'qemu', 'start');
    await provider.waitForTask('pve-b', upid, 2000, 10);
    expect((await provider.guestStatus('pve-b', 220, 'qemu')).status).toBe('running');
  });

  it('surfaces a failed start task', async () => {
    pve.guest(220)!.failStart = 'TASK ERROR: storage local-zfs not available';
    const upid = await provider.powerAction('pve-b', 220, 'qemu', 'start');
    await expect(provider.waitForTask('pve-b', upid, 2000, 10)).rejects.toThrow(/storage local-zfs/);
  });

  it('reports a missing guest', async () => {
    await expect(provider.guestStatus('pve-b', 999, 'qemu')).rejects.toBeInstanceOf(ProviderError);
  });

  it('reads storage, replication and backups', async () => {
    pve.replication = [{ id: '220-0', guest: 220, last_sync: 1_700_000_000, fail_count: 0 }];
    pve.backups = [{ storage: 'pbs', vmid: 120, ctime: 1_700_000_100, volid: 'pbs:backup/vm/120/2023' }];
    expect((await provider.listStorage('pve-b'))[0]).toMatchObject({ storage: 'local-zfs', active: true });
    expect((await provider.replicationJobs('pve-b'))[0]!.last_sync).toBe(1_700_000_000);
    expect((await provider.listBackups('pve-b', 'pbs', 120))[0]!.ctime).toBe(1_700_000_100);
  });

  it('classifies an unreachable host', async () => {
    const dead = new ProxmoxProvider({ http, baseUrl: 'http://127.0.0.1:1', readRetries: 0 }, pve.tokenId, pve.tokenSecret);
    await expect(dead.listNodes()).rejects.toMatchObject({ kind: 'network' });
  });

  it('times out slow responses', async () => {
    pve.fault({ path: /\/nodes$/, delayMs: 400 });
    const slow = new ProxmoxProvider({ http, baseUrl: pve.url, timeoutMs: 100, readRetries: 0 }, pve.tokenId, pve.tokenSecret);
    await expect(slow.listNodes()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports an offline node', async () => {
    pve.nodeStatus = 'offline';
    expect((await provider.listNodes())[0]!.status).toBe('offline');
    await expect(provider.nodeStatus('pve-b')).rejects.toBeInstanceOf(ProviderError);
  });
});
