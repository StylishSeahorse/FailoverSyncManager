import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { World } from '../helpers/world.js';

let w: World;
beforeEach(async () => {
  w = await new World(2).start();
});
afterEach(() => w.stop());

const ctlState = async () => (await w.s.store.controller()).failoverState;

describe('monitoring', () => {
  it('reports a healthy two-site setup and answers YES to failover readiness', async () => {
    await w.observe(2);
    expect(await ctlState()).toBe('HEALTHY_PRIMARY');
    const r = await w.s.readiness.evaluate();
    const fails = r.items.filter((i) => i.status === 'FAIL');
    expect(fails).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.items.find((i) => i.key === 'replication.wordpress')!.message).toMatch(/7 minutes/);
    expect(r.estimatedMaxDataLossSeconds).toBeGreaterThanOrEqual(420);
  });

  it('walks HEALTHY → DEGRADED → FAILURE_DETECTED → CONFIRMING → PRIMARY_CONFIRMED_FAILED and never fails over by itself', async () => {
    await w.observe(2);
    await w.killSiteA();
    await w.observe(1);
    // First failures are only warnings: "Site A HTTP check failed", not "Site A is down".
    expect(await ctlState()).toBe('DEGRADED_PRIMARY');
    await w.observe(1);
    expect(await ctlState()).toBe('PRIMARY_CONFIRMED_FAILED');
    const states = await w.s.store.siteStates();
    expect(states.get(w.siteA.id)!.state).toBe('FAILED');
    expect(states.get(w.siteB.id)!.state).toBe('SECONDARY');
    // Phase 1: no automatic failover. DNS untouched.
    expect(w.cf.records.every((r) => r.content.startsWith('aaaaaaaa'))).toBe(true);

    const transitions = await w.t.db.query(`SELECT from_state, to_state FROM state_transitions WHERE machine = 'failover' ORDER BY id`);
    expect(transitions.rows.map((r) => r.to_state)).toEqual(['DEGRADED_PRIMARY', 'FAILURE_DETECTED', 'CONFIRMING_FAILURE', 'PRIMARY_CONFIRMED_FAILED']);

    const events = await w.s.audit.query({ category: ['health', 'failover'], limit: 200 });
    const msgs = events.map((e) => e.message).reverse();
    expect(msgs.some((m) => /Site A infrastructure check "Proxmox A API" failed/.test(m))).toBe(true);
    expect(msgs.some((m) => /failure confirmed/.test(m))).toBe(true);
  });

  it('a single dropped check does not change the controller state', async () => {
    await w.observe(2);
    w.cf.fault({ path: /cfd_tunnel\/aaaaaaaa/, status: 500, times: 3 });
    await w.observe(1);
    expect(['HEALTHY_PRIMARY', 'DEGRADED_PRIMARY', 'FAILURE_DETECTED']).toContain(await ctlState());
    await w.observe(2);
    expect(await ctlState()).toBe('HEALTHY_PRIMARY');
  });

  it('an SD-WAN-only outage is never confirmed while Site A still serves the public', async () => {
    await w.observe(2);
    // The controller loses its private path to Site A (ICMP, TCP and Proxmox API all fail),
    // but Tunnel A is connected and the public hostnames still answer from Site A.
    w.sdwanUp = false;
    await w.pveA.stop();
    await w.observe(4);
    const c = w.s.monitor.lastConfirmation!;
    expect(c.failedGroups.sort()).toEqual(['icmp', 'proxmox', 'tcp']);
    expect(c.confirmed).toBe(false);
    expect(c.reasons.join(' ')).toMatch(/only fails over the SD-WAN path.*NOT recommended/);
    expect(await ctlState()).toBe('FAILURE_DETECTED');
  });

  it('Cloudflare API failure alone does not confirm a site failure', async () => {
    await w.observe(2);
    w.cf.fault({ path: /cfd_tunnel/, status: 503 });
    await w.observe(4);
    expect(await ctlState()).not.toBe('PRIMARY_CONFIRMED_FAILED');
    expect(w.s.monitor.lastConfirmation!.failedGroups).toEqual(['tunnel']);
  });

  it('readiness says NOT SAFE and explains why when replication is stale and NPM mismatches', async () => {
    w.pveB.backups = w.pveB.backups.map((b) => ({ ...b, ctime: Math.floor(Date.now() / 1000) - 47 * 60 }));
    w.npmB.hosts[0]!.forward_host = '10.2.0.99';
    await w.observe(3);
    const r = await w.s.readiness.evaluate();
    expect(r.verdict).toBe('FAILOVER NOT SAFE');
    const fails = r.items.filter((i) => i.status === 'FAIL').map((i) => i.message);
    expect(fails.some((m) => /WordPress replication is 47 minutes old \(limit 15 minutes\)/.test(m))).toBe(true);
    expect(fails.some((m) => /NPM configuration mismatch: forward_host 10.2.0.99/.test(m))).toBe(true);
  });

  it('pausing monitoring stops the scheduler from recording results', async () => {
    await w.s.store.setMonitoringPaused(true, { type: 'system', name: 'test' });
    w.s.engine.setPaused(true);
    expect((await w.s.readiness.evaluate()).items.some((i) => i.key === 'controller.paused')).toBe(true);
  });
});
