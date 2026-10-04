import { confirmSiteFailure, dimension, siteHealth, type CheckView } from '../health/aggregate.js';
import type { HealthEngine } from '../health/engine.js';
import type { Repos } from '../repos/index.js';
import type { PolicyRepo } from '../repos/policy.js';
import type { StateStore } from '../state/store.js';
import { classifyAge, fmtAge, type ReplicationSafety } from './replication.js';

export type ItemStatus = 'PASS' | 'WARNING' | 'FAIL';

export interface ReadinessItem {
  key: string;
  group: 'controller' | 'site' | 'proxmox' | 'workloads' | 'applications' | 'replication' | 'npm' | 'tunnel' | 'dns';
  status: ItemStatus;
  message: string;
}

export interface Readiness {
  question: string;
  ready: boolean;
  verdict: 'FAILOVER READY' | 'FAILOVER READY WITH WARNINGS' | 'FAILOVER NOT SAFE';
  sourceSiteId: string | null;
  targetSiteId: string | null;
  items: ReadinessItem[];
  estimatedMaxDataLossSeconds: number | null;
  primary: { level: string; reasons: string[] } | null;
  evaluatedAt: Date;
  basis: 'monitoring';
}

/**
 * Answers "If the active site disappeared right now, can I safely move
 * production to the other site?" from the latest monitoring state. Cheap
 * enough for the dashboard to poll. Test Failover re-checks everything live.
 */
export class ReadinessService {
  constructor(
    private readonly repos: Repos,
    private readonly store: StateStore,
    private readonly engine: HealthEngine,
    private readonly policies: PolicyRepo,
  ) {}

  async evaluate(targetSiteId?: string): Promise<Readiness> {
    const [ctl, sites, policy, views, apps] = await Promise.all([
      this.store.controller(),
      this.repos.sites.list(),
      this.policies.active(),
      this.engine.views(),
      this.repos.applications.list(),
    ]);
    const source = sites.find((s) => s.id === ctl.activeSiteId) ?? null;
    const target = sites.find((s) => s.id === targetSiteId) ?? sites.find((s) => s.id !== ctl.activeSiteId) ?? null;
    const items: ReadinessItem[] = [];
    const add = (group: ReadinessItem['group'], key: string, status: ItemStatus, message: string) => items.push({ key, group, status, message });
    const question = `If ${source?.name ?? 'the active site'} disappeared right now, can I safely move production to ${target?.name ?? 'the standby site'}?`;

    if (!source || !target) {
      add('controller', 'controller.sites', 'FAIL', 'Two sites must be configured, with one active');
      return this.result(question, items, null, null, null, null);
    }

    if (ctl.failoverState === 'FAILOVER_FAILED') add('controller', 'controller.failed', 'FAIL', 'Previous failover failed; run Reconcile');
    if (ctl.currentOperationId) add('controller', 'controller.busy', 'WARNING', 'A failover operation is running');
    if (ctl.monitoringPaused) add('controller', 'controller.paused', 'WARNING', 'Monitoring is paused; health information may be stale');

    const enabledApps = apps.filter((a) => a.enabled);
    const health = siteHealth(target.id, views);
    const mine = views.filter((v) => v.check.siteId === target.id && v.check.enabled);

    // Site
    const st = health.site.status;
    if (st === 'HEALTHY') add('site', 'site.health', 'PASS', `${target.name} site checks healthy`);
    else if (st === 'UNKNOWN') add('site', 'site.health', 'FAIL', `${target.name} health unknown (${health.site.reasons.join('; ') || 'no results yet'})`);
    else if (st === 'FAILED' || policy.minimumSecondaryHealth === 'HEALTHY') add('site', 'site.health', st === 'WARNING' ? 'WARNING' : 'FAIL', `${target.name} site ${st}: ${health.site.reasons.join('; ')}`);
    else add('site', 'site.health', 'WARNING', `${target.name} site ${st}: ${health.site.reasons.join('; ')}`);

    // Proxmox
    const pve = mine.filter((v) => v.check.type === 'proxmox_api' || v.check.type === 'proxmox_node');
    this.fromChecks(add, 'proxmox', 'Proxmox', pve, `No Proxmox checks configured for ${target.name}`);

    // Workloads
    for (const app of enabledApps) {
      const ws = await this.repos.workloads.list({ applicationId: app.id, siteId: target.id });
      if (!ws.length) {
        add('workloads', `workloads.${app.slug}`, 'WARNING', `${app.name}: no workload registered at ${target.name}`);
        continue;
      }
      const vmChecks = mine.filter((v) => v.check.type === 'proxmox_vm' && v.check.applicationId === app.id);
      const bad = vmChecks.filter((v) => v.state.status === 'FAILED' || v.state.status === 'DEGRADED');
      if (bad.length) add('workloads', `workloads.${app.slug}`, 'FAIL', `${app.name}: ${bad.map((v) => v.state.lastMessage).join('; ')}`);
      else {
        const cannotStart = ws.filter((w) => w.standbyState === 'stopped' && !w.allowStart);
        if (cannotStart.length) add('workloads', `workloads.${app.slug}`, 'FAIL', `${app.name}: ${cannotStart.map((w) => `VM ${w.vmid}`).join(', ')} stopped and start not permitted`);
        else add('workloads', `workloads.${app.slug}`, 'PASS', `${app.name}: ${ws.length} workload(s) available (${ws.map((w) => `${w.vmid} ${w.standbyState}`).join(', ')})`);
      }
    }

    // Applications
    for (const app of enabledApps) {
      const d = health.applications[app.id];
      const ws = await this.repos.workloads.list({ applicationId: app.id, siteId: target.id });
      const cold = ws.length > 0 && ws.every((w) => w.standbyState === 'stopped');
      if (!d) add('applications', `app.${app.slug}`, 'WARNING', `${app.name}: no application checks for ${target.name}`);
      else if (d.status === 'HEALTHY') add('applications', `app.${app.slug}`, 'PASS', `${app.name} healthy on ${target.name}`);
      else if (cold) add('applications', `app.${app.slug}`, 'PASS', `${app.name}: cold standby, verified after the VM starts`);
      else add('applications', `app.${app.slug}`, d.status === 'WARNING' ? 'WARNING' : 'FAIL', `${app.name} ${d.status} on ${target.name}: ${d.reasons.join('; ')}`);
    }

    // Replication
    let maxLoss: number | null = null;
    for (const app of enabledApps) {
      const rc = mine.find((v) => v.check.type === 'replication' && v.check.applicationId === app.id);
      const observed = rc?.state.lastObserved?.ageSeconds;
      const age = rc && rc.state.status !== 'UNKNOWN' && typeof observed === 'number' ? observed : null;
      const safety: ReplicationSafety = classifyAge(age, app.maxReplicationAgeSeconds);
      if (age !== null) maxLoss = Math.max(maxLoss ?? 0, age);
      const lim = fmtAge(app.maxReplicationAgeSeconds);
      if (safety === 'SAFE') add('replication', `replication.${app.slug}`, 'PASS', `${app.name} replication age: ${fmtAge(age!)}`);
      else if (safety === 'WARNING') add('replication', `replication.${app.slug}`, 'WARNING', `${app.name} replication age: ${fmtAge(age!)} (limit ${lim})`);
      else if (safety === 'UNSAFE') add('replication', `replication.${app.slug}`, 'FAIL', `${app.name} replication is ${fmtAge(age!)} old (limit ${lim})`);
      else add('replication', `replication.${app.slug}`, 'FAIL', `${app.name} replication age unknown${rc ? ` (${rc.state.lastMessage || 'no result yet'})` : ' (no replication check configured)'}`);
    }

    // NPM
    const npm = mine.filter((v) => v.check.type === 'npm_api' || v.check.type === 'npm_proxy_host');
    this.fromChecks(add, 'npm', 'NPM', npm, `No NPM checks configured for ${target.name}`);

    // Tunnel
    if (health.tunnel.status === 'UNKNOWN' && !health.tunnel.checks.length) add('tunnel', 'tunnel', 'WARNING', `No tunnel checks configured for ${target.name}`);
    else this.fromChecks(add, 'tunnel', 'Tunnel', mine.filter((v) => v.check.category === 'tunnel'), '');

    // DNS
    let recordCount = 0;
    for (const app of enabledApps) {
      const recs = await this.repos.dnsRecords.list({ applicationId: app.id });
      recordCount += recs.length;
      if (!recs.length) add('dns', `dns.${app.slug}`, 'WARNING', `${app.name}: no managed DNS records`);
    }
    if (recordCount) add('dns', 'dns.records', 'PASS', `${recordCount} managed DNS record(s) with primary and secondary targets (contents verified by Test Failover)`);

    const conf = confirmSiteFailure(source.name, source.id, views, policy);
    return this.result(question, items, source.id, target.id, maxLoss, { level: conf.level, reasons: conf.reasons });
  }

  private fromChecks(add: (g: ReadinessItem['group'], k: string, s: ItemStatus, m: string) => void, group: ReadinessItem['group'], label: string, vs: CheckView[], empty: string) {
    if (!vs.length) {
      if (empty) add(group, group, 'WARNING', empty);
      return;
    }
    const d = dimension(vs);
    for (const c of d.checks) {
      const status: ItemStatus = c.status === 'OK' ? 'PASS' : c.status === 'WARNING' || c.status === 'UNKNOWN' || !c.critical ? 'WARNING' : 'FAIL';
      add(group, `${group}.${c.id}`, status, `${label}: ${c.name}${c.message ? ` (${c.message})` : ''}`);
    }
  }

  private result(question: string, items: ReadinessItem[], sourceSiteId: string | null, targetSiteId: string | null, loss: number | null, primary: Readiness['primary']): Readiness {
    const fail = items.some((i) => i.status === 'FAIL');
    const warn = items.some((i) => i.status === 'WARNING');
    return {
      question,
      ready: !fail,
      verdict: fail ? 'FAILOVER NOT SAFE' : warn ? 'FAILOVER READY WITH WARNINGS' : 'FAILOVER READY',
      sourceSiteId,
      targetSiteId,
      items,
      estimatedMaxDataLossSeconds: loss,
      primary,
      evaluatedAt: new Date(),
      basis: 'monitoring',
    };
  }
}
