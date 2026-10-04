import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/types.js';
import { OperationConflictError, PreconditionError } from '../../src/orchestrator/orchestrator.js';
import { tunnelCname } from '../../src/providers/cloudflare/CloudflareProvider.js';
import { SplitBrainError } from '../../src/state/store.js';
import { TUN_A, TUN_B, World } from '../helpers/world.js';

const admin: Actor = { type: 'user', id: '00000000-0000-0000-0000-0000000000aa', name: 'admin' };
const operator: Actor = { type: 'user', id: '00000000-0000-0000-0000-0000000000bb', name: 'operator' };

let w: World;
afterEach(() => w?.stop());

const start = async (apps = 3, opts: { secondaryRunning?: boolean } = {}) => {
  w = await new World(apps).start(opts);
  await w.observe(2);
  return w;
};
const ctl = () => w.s.store.controller();
const dnsTargets = () => w.cf.records.map((r) => (r.content === tunnelCname(TUN_A) ? 'A' : r.content === tunnelCname(TUN_B) ? 'B' : r.content));
const phrase = () => `FAILOVER TO ${w.siteB.name.toUpperCase()}`;

async function execute(o: { acknowledge?: string[]; reason?: string; actor?: Actor; canOverride?: boolean } = {}) {
  const op = await w.s.orchestrator.execute({
    targetSiteId: w.siteB.id,
    confirm: phrase(),
    acknowledge: o.acknowledge,
    reason: o.reason,
    actor: o.actor ?? admin,
    canOverride: o.canOverride ?? true,
  });
  await w.s.orchestrator.wait(op.id);
  return (await w.s.operations.get(op.id))!;
}

async function failedOver() {
  await w.killSiteA();
  await w.observe(3);
  expect((await ctl()).failoverState).toBe('PRIMARY_CONFIRMED_FAILED');
}

describe('Test Failover (dry run)', () => {
  it('simulates the whole sequence without changing DNS, VMs or NPM', async () => {
    await start();
    const before = JSON.stringify(w.cf.records);
    const op = await w.s.orchestrator.startDryRun(w.siteB.id, operator);
    await w.s.orchestrator.wait(op.id);
    const done = (await w.s.operations.get(op.id))!;
    const steps = await w.s.operations.steps(op.id);
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));

    expect(done.status).toBe('succeeded');
    expect(done.verdict).toBe('READY WITH WARNINGS'); // cold standby apps answer only after promotion
    expect(by.check_secondary!.status).toBe('PASS');
    expect(by.check_replication!.message).toMatch(/WordPress replication age 7 minutes \(limit 15 minutes\)/);
    expect(by.check_replication!.message).toMatch(/Estimated maximum data loss: 7 minutes/);
    expect(by.validate_npm!.status).toBe('PASS');
    expect(by.validate_tunnel!.status).toBe('PASS');
    expect(by.validate_dns!.status).toBe('PASS');
    expect(by.promote_workloads!.status).toBe('PLANNED');
    expect(by.promote_workloads!.message).toMatch(/would start WordPress VM 220/);
    expect(by.update_dns!.status).toBe('PLANNED');
    expect(by.update_dns!.message).toMatch(/would update www.example.com, cloud.example.com, invoices.example.com/);
    expect(by.verify_traffic!.status).toBe('SKIPPED');

    expect(JSON.stringify(w.cf.records)).toBe(before);
    expect(w.cf.countRequests('PATCH', /dns_records/)).toBe(0);
    expect(w.pveB.guests.every((g) => g.status === 'stopped')).toBe(true);
    expect(w.pveB.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(w.npmB.requests.some((r) => r.method === 'POST' && r.path.includes('/enable'))).toBe(false);
    expect((await ctl()).failoverState).toBe('HEALTHY_PRIMARY');
  });

  it('is READY FOR FAILOVER with a warm standby', async () => {
    await start(3, { secondaryRunning: true });
    const op = await w.s.orchestrator.startDryRun(w.siteB.id, operator);
    await w.s.orchestrator.wait(op.id);
    const done = (await w.s.operations.get(op.id))!;
    const steps = await w.s.operations.steps(op.id);
    // only verify_traffic (runs after DNS) and wait_propagation are skipped
    expect(steps.filter((s) => s.status === 'WARNING' || s.status === 'FAIL')).toEqual([]);
    expect(done.verdict).toBe('READY FOR FAILOVER');
  });

  it('reports NOT READY with the exact reasons for stale replication and NPM mismatch', async () => {
    await start(2);
    w.pveB.backups = w.pveB.backups.map((b) => ({ ...b, ctime: Math.floor(Date.now() / 1000) - 47 * 60 }));
    w.npmB.hosts[1]!.forward_port = 8080;
    const op = await w.s.orchestrator.startDryRun(w.siteB.id, operator);
    await w.s.orchestrator.wait(op.id);
    const done = (await w.s.operations.get(op.id))!;
    expect(done.verdict).toBe('NOT READY');
    const blockers = (done.summary as { blockers: Array<{ key: string; message: string; overridable: boolean }> }).blockers;
    expect(blockers.find((b) => b.key === 'replication.wordpress')).toMatchObject({ overridable: true, message: 'WordPress replication is 47 minutes old (limit 15 minutes)' });
    expect(blockers.find((b) => b.key.startsWith('npm.'))!.message).toMatch(/Nextcloud NPM cloud.example.com configuration mismatch: forward_port 8080 ≠ expected 80/);
  });
});

describe('manual failover', () => {
  it('Site A power failure: confirms, promotes Site B, switches DNS, verifies traffic, marks Site B ACTIVE', async () => {
    await start();
    await failedOver();
    const op = await execute();
    expect(op.status).toBe('succeeded');
    expect(dnsTargets()).toEqual(['B', 'B', 'B']);
    expect(w.pveB.guests.every((g) => g.status === 'running')).toBe(true);
    const c = await ctl();
    expect(c.failoverState).toBe('SECONDARY_ACTIVE');
    expect(c.activeSiteId).toBe(w.siteB.id);
    expect(c.currentOperationId).toBeNull();
    const states = await w.s.store.siteStates();
    expect(states.get(w.siteB.id)!.state).toBe('ACTIVE');
    expect(states.get(w.siteA.id)!.state).toBe('FAILED');
    for (const app of await w.s.repos.applications.list()) expect(app.activeSiteId).toBe(w.siteB.id);

    const steps = await w.s.operations.steps(op.id);
    expect(steps.map((s) => s.key)).toEqual([
      'assess_primary', 'check_secondary', 'check_workloads', 'check_replication', 'validate_npm', 'validate_tunnel', 'validate_dns', 'check_blockers',
      'promote_workloads', 'wait_services', 'revalidate_npm', 'revalidate_tunnel', 'update_dns', 'wait_propagation', 'verify_traffic',
    ]);
    expect(steps.find((s) => s.key === 'verify_traffic')!.message).toMatch(/External HTTPS validation successful/);

    const transitions = await w.t.db.query(`SELECT to_state FROM state_transitions WHERE machine = 'failover' AND operation_id = $1 ORDER BY id`, [op.id]);
    expect(transitions.rows.map((r) => r.to_state)).toEqual(['CHECK_SECONDARY', 'SECONDARY_READY', 'PROMOTING_SECONDARY', 'UPDATING_ROUTING', 'VERIFYING_TRAFFIC', 'SECONDARY_ACTIVE']);

    const log = (await w.s.audit.query({ operationId: op.id, limit: 200 })).reverse().map((e) => `${e.severity} ${e.message}`);
    expect(log.some((l) => /^SUCCESS Start WordPress workload on Site B/.test(l))).toBe(true);
    expect(log.some((l) => /^SUCCESS Cloudflare DNS CNAME www.example.com: aaaaaaaa.* → bbbbbbbb/.test(l))).toBe(true);
    expect(log.at(-1)).toBe('SUCCESS Site B ACTIVE');
  });

  it('never modifies unmanaged DNS records', async () => {
    await start(1);
    const other = w.cf.addRecord({ name: 'mail.example.com', type: 'A', content: '203.0.113.5', ttl: 300, proxied: false });
    await failedOver();
    await execute();
    expect(w.cf.record('mail.example.com')).toEqual(other);
    expect(w.cf.requests.filter((r) => r.method === 'PATCH').every((r) => !r.path.endsWith(other.id))).toBe(true);
  });

  it('refuses a planned switchover unless an admin explicitly acknowledges it with a reason', async () => {
    await start(1);
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: operator, canOverride: false }).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.blockers.map((b: { key: string }) => b.key)).toEqual(['primary.reachable']);
    expect(err.blockers[0].message).toMatch(/anything written to Site A since the last replication will be lost/);
    expect((await ctl()).failoverState).toBe('HEALTHY_PRIMARY'); // a refusal changes nothing

    await expect(
      w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), acknowledge: ['primary.reachable'], reason: 'maintenance', actor: operator, canOverride: false }),
    ).rejects.toThrow(/Only administrators/);
    await expect(w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), acknowledge: ['primary.reachable'], actor: admin, canOverride: true })).rejects.toThrow(/reason is required/);

    const op = await execute({ acknowledge: ['primary.reachable'], reason: 'Planned power work at Site A' });
    expect(op.status).toBe('succeeded');
    expect(op.acknowledged).toEqual(['primary.reachable']);
    const states = await w.s.store.siteStates();
    expect(states.get(w.siteA.id)!.state).toBe('SECONDARY');
    expect(states.get(w.siteB.id)!.state).toBe('ACTIVE');
    const forced = await w.s.audit.query({ q: 'FORCED' });
    expect(forced[0]!.severity).toBe('CRITICAL');
  });

  it('requires the exact confirmation phrase', async () => {
    await start(1);
    await expect(w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: 'yes', actor: admin, canOverride: true })).rejects.toThrow(/FAILOVER TO SITE B/);
  });

  it('blocks stale replication; Force Failover proceeds only with the blocker acknowledged', async () => {
    await start(1);
    await failedOver();
    w.pveB.backups = w.pveB.backups.map((b) => ({ ...b, ctime: Math.floor(Date.now() / 1000) - 3 * 3600 }));
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true }).catch((e) => e);
    expect(err.blockers).toEqual([expect.objectContaining({ key: 'replication.wordpress', overridable: true })]);
    expect(dnsTargets()).toEqual(['A']);
    const op = await execute({ acknowledge: ['replication.wordpress'], reason: 'Site A destroyed; 3h data loss accepted' });
    expect(op.status).toBe('succeeded');
    expect(dnsTargets()).toEqual(['B']);
  });

  it('refuses when replication age is unknown', async () => {
    await start(1);
    await failedOver();
    w.pveB.backups = [];
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true }).catch((e) => e);
    expect(err.blockers[0].message).toMatch(/no successful replication\/backup found.*cannot estimate data loss/);
  });

  it('refuses to touch a DNS record that was edited out of band (not overridable)', async () => {
    await start(2);
    await failedOver();
    w.cf.record('cloud.example.com')!.content = 'someone-else.example.net';
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), acknowledge: [], actor: admin, canOverride: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    const b = err.blockers.find((x: { key: string }) => x.key === 'dns.cloud.example.com');
    expect(b).toMatchObject({ overridable: false });
    expect(b.message).toMatch(/neither the primary nor the secondary target/);
    expect(w.cf.countRequests('PATCH', /dns_records/)).toBe(0);
  });

  it('refuses when Tunnel B has no ingress for a hostname being moved', async () => {
    await start(1);
    await failedOver();
    w.cf.tunnels.get(TUN_B)!.config!.ingress = [{ service: 'http_status:404' }];
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true }).catch((e) => e);
    expect(err.blockers.map((b: { key: string }) => b.key)).toContain('tunnel.ingress');
  });

  it('refuses to start a VM whose name does not match its registration', async () => {
    await start(1);
    await failedOver();
    w.pveB.guest(220)!.name = 'some-other-vm';
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true }).catch((e) => e);
    expect(err.blockers[0].message).toMatch(/named "some-other-vm", expected "wordpress-b"; refusing to touch it/);
    expect(w.pveB.guest(220)!.status).toBe('stopped');
  });

  it('simultaneous failure of both sites: refuses and explains', async () => {
    await start(1);
    await failedOver();
    await w.pveB.stop();
    const err = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.blockers.some((b: { key: string; overridable: boolean }) => b.key.startsWith('secondary.proxmox') && !b.overridable)).toBe(true);
    expect(dnsTargets()).toEqual(['A']);
    expect((await ctl()).failoverState).toBe('PRIMARY_CONFIRMED_FAILED');
  });
});

describe('failures during failover', () => {
  it('Site B fails during promotion: FAILOVER_FAILED at promote_workloads, DNS untouched', async () => {
    await start(2);
    await failedOver();
    w.pveB.guest(230)!.failStart = 'TASK ERROR: storage local-zfs is not online';
    const op = await execute();
    expect(op.status).toBe('failed');
    expect(op.failedStage).toBe('promote_workloads');
    expect(op.error).toMatch(/storage local-zfs is not online/);
    expect(dnsTargets()).toEqual(['A', 'A']);
    expect((await ctl()).failoverState).toBe('FAILOVER_FAILED');
    expect((await ctl()).currentOperationId).toBeNull();
    const states = await w.s.store.siteStates();
    expect(states.get(w.siteB.id)!.state).toBe('SECONDARY');
    const crit = await w.s.audit.query({ severity: ['CRITICAL'], operationId: op.id });
    expect(crit[0]!.message).toMatch(/FAILOVER FAILED at stage "promote_workloads"/);
  });

  it('Cloudflare fails mid-DNS: stops, reports per-record state, does not roll back; reconcile sees mixed routing', async () => {
    await start(3);
    await failedOver();
    w.cf.fault({ method: 'PATCH', path: /dns_records/, status: 500, after: 1 });
    const op = await execute();
    expect(op.status).toBe('failed');
    expect(op.failedStage).toBe('update_dns');
    const dns = (op.summary as { dns: Array<{ name: string; result: string }> }).dns;
    expect(dns.map((d) => d.result)).toEqual(['updated', 'failed', 'not_attempted']);
    expect(dnsTargets()).toEqual(['B', 'A', 'A']);
    expect((await ctl()).failoverState).toBe('FAILOVER_FAILED');

    // Sticky: no new failover until reconciled.
    await expect(w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true })).rejects.toBeInstanceOf(OperationConflictError);
    const r = await w.s.orchestrator.reconcile(admin);
    expect(r.outcome).toBe('mixed');
    expect((await ctl()).failoverState).toBe('FAILOVER_FAILED');

    // Operator fixes DNS by hand to Site B, then reconcile settles the state.
    w.cf.clearFaults();
    for (const rec of w.cf.records) rec.content = tunnelCname(TUN_B);
    const r2 = await w.s.orchestrator.reconcile(admin);
    expect(r2.outcome).toBe('secondary');
    expect((await ctl()).failoverState).toBe('SECONDARY_ACTIVE');
    expect((await ctl()).activeSiteId).toBe(w.siteB.id);
    expect((await w.s.store.siteStates()).get(w.siteB.id)!.state).toBe('ACTIVE');
  });

  it('NPM fails during failover (after promotion): FAILOVER_FAILED at revalidate_npm, DNS untouched', async () => {
    await start(3);
    await failedOver();
    // preflight (3) + live validation (3) succeed, then NPM B starts failing
    w.npmB.fault({ method: 'GET', path: /proxy-hosts\/\d+/, status: 500, after: 6 });
    const op = await execute();
    expect(op.status).toBe('failed');
    expect(op.failedStage).toBe('revalidate_npm');
    expect(dnsTargets()).toEqual(['A', 'A', 'A']);
    expect((await ctl()).failoverState).toBe('FAILOVER_FAILED');
  });

  it('traffic verification failure after DNS change ends in FAILOVER_FAILED, not SECONDARY_ACTIVE', async () => {
    await start(1);
    await failedOver();
    // Site B app breaks right after DNS changes: edge answers 502.
    let patched = false;
    const iv = setInterval(() => {
      if (!patched && w.cf.countRequests('PATCH', /dns_records/) > 0) {
        patched = true;
        w.pveB.guest(220)!.status = 'stopped';
      }
    }, 2);
    const op = await execute();
    clearInterval(iv);
    expect(op.status).toBe('failed');
    expect(op.failedStage).toBe('verify_traffic');
    expect(dnsTargets()).toEqual(['B']);
    expect((await ctl()).failoverState).toBe('FAILOVER_FAILED');
  });

  it('a pre-change failure aborts back to the starting state', async () => {
    await start(1);
    await failedOver();
    // Passes the preflight, then Proxmox B storage queries start failing before the live validation.
    w.pveB.fault({ method: 'GET', path: /\/storage$/, status: 500, after: 1 });
    const op = await execute();
    expect(op.status).toBe('failed');
    expect(op.failedStage).toBe('check_secondary');
    expect((await ctl()).failoverState).toBe('PRIMARY_CONFIRMED_FAILED');
    const ev = await w.s.audit.query({ q: 'aborted', operationId: op.id });
    expect(ev[0]!.message).toMatch(/before any change; routing untouched/);
  });
});

describe('cancel, concurrency and split-brain', () => {
  it('cancels during promotion: remaining VMs not started, DNS untouched, state restored', async () => {
    await start(3);
    await failedOver();
    w.pveB.taskDelayMs = 150;
    const op = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true });
    for (let i = 0; i < 100 && (await ctl()).failoverState !== 'PROMOTING_SECONDARY'; i++) await new Promise((r) => setTimeout(r, 10));
    await w.s.orchestrator.cancel(operator);
    await w.s.orchestrator.wait(op.id);
    const done = (await w.s.operations.get(op.id))!;
    expect(done.status).toBe('cancelled');
    expect(dnsTargets()).toEqual(['A', 'A', 'A']);
    expect(w.pveB.guests.filter((g) => g.status === 'running').length).toBeLessThan(3);
    expect((await ctl()).failoverState).toBe('PRIMARY_CONFIRMED_FAILED');
  });

  it('refuses to cancel once routing changes have started', async () => {
    await start(1);
    await failedOver();
    w.cf.fault({ method: 'PATCH', path: /dns_records/, delayMs: 300, times: 1 });
    const op = await w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true });
    for (let i = 0; i < 200 && (await ctl()).failoverState !== 'UPDATING_ROUTING'; i++) await new Promise((r) => setTimeout(r, 5));
    await expect(w.s.orchestrator.cancel(operator)).rejects.toThrow(/routing changes have started/);
    await w.s.orchestrator.wait(op.id);
    expect((await w.s.operations.get(op.id))!.status).toBe('succeeded');
  });

  it('only one failover can run at a time', async () => {
    await start(1);
    await failedOver();
    w.pveB.taskDelayMs = 100;
    const first = w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: admin, canOverride: true });
    const second = w.s.orchestrator.execute({ targetSiteId: w.siteB.id, confirm: phrase(), actor: operator, canOverride: true });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OperationConflictError);
    await w.s.orchestrator.waitAll();
  });

  it('never allows both sites to be serving', async () => {
    await start(1);
    await w.s.store.transitionSites([{ site: w.siteB, event: 'PROMOTE_START', reason: 'test' }], { actor: admin });
    await expect(w.s.store.transitionSites([{ site: w.siteB, event: 'PROMOTED', reason: 'test' }], { actor: admin })).rejects.toBeInstanceOf(SplitBrainError);
    const states = await w.s.store.siteStates();
    expect(states.get(w.siteA.id)!.state).toBe('PRIMARY');
    expect(states.get(w.siteB.id)!.state).toBe('PROMOTING');
    expect((await w.s.audit.query({ q: 'Split-brain' }))[0]!.severity).toBe('CRITICAL');
  });

  it('a second failover after success is refused (failback is separate)', async () => {
    await start(1);
    await failedOver();
    await execute();
    await expect(w.s.orchestrator.execute({ targetSiteId: w.siteA.id, confirm: 'FAILOVER TO SITE A', actor: admin, canOverride: true })).rejects.toThrow(/failback is a separate operation/);
  });
});

describe('recovery', () => {
  it('Site A recovering before anyone fails over returns to HEALTHY_PRIMARY', async () => {
    await start(1);
    await failedOver();
    await w.restoreSiteA();
    await w.observe(3);
    expect((await ctl()).failoverState).toBe('HEALTHY_PRIMARY');
    expect((await w.s.store.siteStates()).get(w.siteA.id)!.state).toBe('PRIMARY');
  });

  it('after failover, Site A returning goes to RECOVERY and does NOT fail back automatically', async () => {
    await start(1);
    await failedOver();
    await execute();
    await w.restoreSiteA();
    await w.observe(3);
    expect((await w.s.store.siteStates()).get(w.siteA.id)!.state).toBe('RECOVERY');
    expect((await ctl()).failoverState).toBe('SECONDARY_ACTIVE');
    expect(dnsTargets()).toEqual(['B']);
  });

  it('a controller restart mid-failover marks the operation failed and the state FAILOVER_FAILED', async () => {
    await start(1);
    await failedOver();
    // Simulate a crash: an operation left running with the controller mid-flight.
    const op = await w.s.operations.create({ kind: 'failover', sourceSiteId: w.siteA.id, targetSiteId: w.siteB.id, requestedBy: null, requestedByName: 'admin' });
    await w.s.store.transitionFailover('BEGIN_FAILOVER', { actor: admin, reason: 'test', operationId: op.id, set: { currentOperationId: op.id } });
    await w.s.initialise();
    expect((await w.s.operations.get(op.id))!.status).toBe('failed');
    const c = await ctl();
    expect(c.failoverState).toBe('FAILOVER_FAILED');
    expect(c.currentOperationId).toBeNull();
  });
});
