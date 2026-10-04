import type { AuditLog } from '../audit/audit.js';
import type { HealthEngine } from '../health/engine.js';
import { confirmSiteFailure, siteHealth } from '../health/aggregate.js';
import { runCheck } from '../health/checks/executors.js';
import type { CheckDeps } from '../health/checks/types.js';
import type { Actor, HealthCheck, StepStatus } from '../domain/types.js';
import { ingressCovers } from '../providers/cloudflare/CloudflareProvider.js';
import { compareProxyHost, describeMismatch } from '../providers/npm/NpmProvider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Repos } from '../repos/index.js';
import type { ChangeExecutor } from './changes.js';
import type { FailoverPlan } from './plan.js';
import { fmtAge, type ReplicationService } from './replication.js';

export interface Blocker {
  key: string;
  message: string;
  overridable: boolean;
}

export interface StepOutcome {
  status: StepStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface StepContext {
  plan: FailoverPlan;
  dryRun: boolean;
  actor: Actor;
  operationId: string | null;
  acknowledged: Set<string>;
  blockers: Map<string, Blocker>;
  changes: ChangeExecutor;
  repos: Repos;
  providers: ProviderRegistry;
  engine: HealthEngine;
  replication: ReplicationService;
  checkDeps: CheckDeps;
  audit: AuditLog;
  /** Polling cadence for waits (ms). */
  pollMs: number;
  isCancelled: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Highest replication age seen, for the data-loss estimate. */
  maxDataLossSeconds: number | null;
  dnsResults: Array<{ name: string; result: 'updated' | 'already' | 'failed' | 'not_attempted' | 'planned'; detail?: string }>;
}

export interface StepDef {
  key: string;
  name: string;
  /** Mutating steps only plan in a dry run. */
  mutating: boolean;
  run(ctx: StepContext): Promise<StepOutcome>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function block(ctx: StepContext, key: string, message: string, overridable: boolean) {
  ctx.blockers.set(key, { key, message, overridable });
}

/** Turns a set of per-item lines into a step outcome. */
function summarise(lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }>, empty: StepOutcome): StepOutcome {
  if (!lines.length) return empty;
  const status: StepStatus = lines.some((l) => l.ok === 'FAIL') ? 'FAIL' : lines.some((l) => l.ok === 'WARNING') ? 'WARNING' : 'PASS';
  return { status, message: lines.map((l) => l.text).join('; '), details: { items: lines } };
}

// ---------------------------------------------------------------- step 1
const assessPrimary: StepDef = {
  key: 'assess_primary',
  name: 'Confirm primary failure',
  mutating: false,
  async run(ctx) {
    const { source, policy } = ctx.plan;
    await ctx.engine.runSite(source.id);
    const views = await ctx.engine.views();
    const conf = confirmSiteFailure(source.name, source.id, views, policy);
    const details = { level: conf.level, failedGroups: conf.failedGroups, healthyGroups: conf.healthyGroups, reasons: conf.reasons };
    if (conf.confirmed) return { status: 'PASS', message: conf.reasons.join('; '), details };
    if (ctx.dryRun) {
      return { status: 'PASS', message: `${source.name} is currently ${conf.level} (test assumes ${source.name} has failed)`, details };
    }
    block(
      ctx,
      'primary.reachable',
      `${source.name} is not confirmed failed (${conf.level}${conf.reasons.length ? `: ${conf.reasons.join('; ')}` : ''}). ` +
        `This would be a planned switchover: anything written to ${source.name} since the last replication will be lost`,
      true,
    );
    return { status: ctx.acknowledged.has('primary.reachable') ? 'WARNING' : 'FAIL', message: ctx.blockers.get('primary.reachable')!.message, details };
  },
};

// ---------------------------------------------------------------- step 2
const checkSecondary: StepDef = {
  key: 'check_secondary',
  name: 'Verify secondary site',
  mutating: false,
  async run(ctx) {
    const { target, policy } = ctx.plan;
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    const instances = await ctx.repos.proxmox.list({ siteId: target.id });
    if (!instances.length) {
      block(ctx, 'secondary.proxmox', `No Proxmox instance configured for ${target.name}`, false);
      lines.push({ ok: 'FAIL', text: `No Proxmox instance configured for ${target.name}` });
    }
    const workloadNodes = new Set(ctx.plan.apps.flatMap((a) => a.targetWorkloads.map((w) => `${w.proxmoxInstanceId}/${w.node}`)));
    for (const inst of instances) {
      try {
        const pve = await ctx.providers.proxmox(inst.id);
        const nodes = await pve.listNodes();
        for (const n of nodes) {
          const needed = workloadNodes.has(`${inst.id}/${n.node}`);
          if (n.status !== 'online') {
            if (needed) block(ctx, `secondary.node.${n.node}`, `${target.name} Proxmox node ${n.node} is ${n.status}`, false);
            lines.push({ ok: needed ? 'FAIL' : 'WARNING', text: `Proxmox node ${n.node} ${n.status}` });
            continue;
          }
          const s = await pve.nodeStatus(n.node);
          const mem = s.memory.total ? s.memory.used / s.memory.total : 0;
          const tight = s.cpu > 0.9 || mem > 0.9;
          lines.push({ ok: tight ? 'WARNING' : 'PASS', text: `Proxmox ${inst.name} node ${n.node} online (CPU ${Math.round(s.cpu * 100)}%, RAM ${Math.round(mem * 100)}%)` });
          if (needed) {
            const storage = await pve.listStorage(n.node);
            const inactive = storage.filter((st) => st.enabled && !st.active).map((st) => st.storage);
            if (inactive.length) lines.push({ ok: 'WARNING', text: `storage not active on ${n.node}: ${inactive.join(', ')}` });
          }
        }
        for (const key of workloadNodes) {
          const [instId, node] = key.split('/') as [string, string];
          if (instId === inst.id && !nodes.some((n) => n.node === node)) {
            block(ctx, `secondary.node.${node}`, `Proxmox node ${node} (used by protected workloads) not found on ${inst.name}`, false);
            lines.push({ ok: 'FAIL', text: `Proxmox node ${node} not found` });
          }
        }
      } catch (e) {
        block(ctx, `secondary.proxmox.${inst.name}`, `${target.name} Proxmox ${inst.name} unavailable: ${errMsg(e)}`, false);
        lines.push({ ok: 'FAIL', text: `Proxmox ${inst.name} unavailable: ${errMsg(e)}` });
      }
    }
    // Fresh site-level checks at the target.
    await ctx.engine.runSite(target.id, (c) => (c.category === 'network' || c.category === 'infrastructure') && !c.applicationId);
    const health = siteHealth(target.id, await ctx.engine.views());
    const st = health.site.status;
    const minOk = policy.minimumSecondaryHealth === 'HEALTHY' ? st === 'HEALTHY' : st !== 'FAILED' && st !== 'UNKNOWN';
    if (st === 'FAILED') {
      block(ctx, 'secondary.health', `${target.name} site checks FAILED: ${health.site.reasons.join('; ')}`, false);
      lines.push({ ok: 'FAIL', text: `${target.name} site checks FAILED` });
    } else if (!minOk) {
      block(ctx, 'secondary.health', `${target.name} site health is ${st}, policy requires ${policy.minimumSecondaryHealth}${health.site.reasons.length ? `: ${health.site.reasons.join('; ')}` : ''}`, true);
      lines.push({ ok: ctx.acknowledged.has('secondary.health') ? 'WARNING' : 'FAIL', text: `${target.name} site health ${st} (policy requires ${policy.minimumSecondaryHealth})` });
    } else {
      lines.push({ ok: st === 'HEALTHY' ? 'PASS' : 'WARNING', text: `${target.name} site checks ${st}` });
    }
    return summarise(lines, { status: 'FAIL', message: 'Nothing to verify' });
  },
};

// ---------------------------------------------------------------- step 3
const checkWorkloads: StepDef = {
  key: 'check_workloads',
  name: 'Verify standby workloads',
  mutating: false,
  async run(ctx) {
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    for (const { app, targetWorkloads } of ctx.plan.apps) {
      if (!targetWorkloads.length) {
        lines.push({ ok: 'WARNING', text: `${app.name}: no workload registered at ${ctx.plan.target.name}` });
        continue;
      }
      for (const w of targetWorkloads) {
        const label = `${app.name} ${w.kind === 'lxc' ? 'CT' : 'VM'} ${w.vmid}`;
        try {
          const pve = await ctx.providers.proxmox(w.proxmoxInstanceId);
          const g = await pve.guestStatus(w.node, w.vmid, w.kind);
          if (g.name !== w.expectedName) {
            block(ctx, `workload.${w.id}.identity`, `${label} is named "${g.name}", expected "${w.expectedName}"; refusing to touch it`, false);
            lines.push({ ok: 'FAIL', text: `${label} name "${g.name}" ≠ "${w.expectedName}"` });
          } else if (g.lock) {
            block(ctx, `workload.${w.id}.locked`, `${label} is locked (${g.lock})`, false);
            lines.push({ ok: 'FAIL', text: `${label} locked (${g.lock})` });
          } else if (g.status === 'running') {
            lines.push({ ok: 'PASS', text: `${label} available (running)` });
          } else if (g.status === 'stopped' && w.allowStart) {
            lines.push({ ok: 'PASS', text: `${label} available (stopped, will be started)` });
          } else if (g.status === 'stopped') {
            block(ctx, `workload.${w.id}.start`, `${label} is stopped and FSM is not permitted to start it`, false);
            lines.push({ ok: 'FAIL', text: `${label} stopped and start not permitted` });
          } else {
            block(ctx, `workload.${w.id}.state`, `${label} is ${g.status}`, false);
            lines.push({ ok: 'FAIL', text: `${label} is ${g.status}` });
          }
        } catch (e) {
          block(ctx, `workload.${w.id}.missing`, `${label} unavailable: ${errMsg(e)}`, false);
          lines.push({ ok: 'FAIL', text: `${label} unavailable: ${errMsg(e)}` });
        }
      }
    }
    return summarise(lines, { status: 'WARNING', message: 'No applications enabled' });
  },
};

// ---------------------------------------------------------------- step 4
const checkReplication: StepDef = {
  key: 'check_replication',
  name: 'Verify replication age',
  mutating: false,
  async run(ctx) {
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    const per: Record<string, unknown> = {};
    for (const { app } of ctx.plan.apps) {
      const r = await ctx.replication.assess(app, ctx.plan.target.id);
      per[app.slug] = { safety: r.safety, ageSeconds: r.ageSeconds, lastSync: r.lastSync, maxAgeSeconds: r.maxAgeSeconds };
      if (r.ageSeconds !== null) ctx.maxDataLossSeconds = Math.max(ctx.maxDataLossSeconds ?? 0, r.ageSeconds);
      if (r.safety === 'SAFE') lines.push({ ok: 'PASS', text: r.message });
      else if (r.safety === 'WARNING') lines.push({ ok: 'WARNING', text: r.message });
      else {
        const key = `replication.${app.slug}`;
        block(ctx, key, r.safety === 'UNKNOWN' ? `${r.message}; cannot estimate data loss` : r.message, true);
        lines.push({ ok: ctx.acknowledged.has(key) ? 'WARNING' : 'FAIL', text: r.message });
      }
    }
    const out = summarise(lines, { status: 'WARNING', message: 'No applications enabled' });
    const loss = ctx.maxDataLossSeconds;
    return {
      ...out,
      message: `${out.message}${loss !== null ? `. Estimated maximum data loss: ${fmtAge(loss)}` : ''}`,
      details: { ...out.details, applications: per, estimatedMaxDataLossSeconds: loss },
    };
  },
};

// ---------------------------------------------------------------- step 5 (read-only parts of 8/9/10, so preflight catches them)
const validateNpm: StepDef = {
  key: 'validate_npm',
  name: 'Validate Nginx Proxy Manager',
  mutating: false,
  async run(ctx) {
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    for (const { app, targetNpm } of ctx.plan.apps) {
      if (!targetNpm.length) {
        lines.push({ ok: 'WARNING', text: `${app.name}: no expected NPM configuration defined for ${ctx.plan.target.name}` });
        continue;
      }
      for (const exp of targetNpm) {
        const label = `${app.name} NPM ${exp.domainNames[0] ?? ''}`;
        const key = `npm.${exp.id}`;
        try {
          if (!exp.proxyHostId) throw new Error('proxy host not linked; run NPM discovery');
          const npm = await ctx.providers.npm(exp.npmInstanceId);
          let host = await npm.getProxyHost(exp.proxyHostId);
          let mism = compareProxyHost(host, exp);
          if (mism.length === 1 && mism[0]!.field === 'enabled' && exp.allowAutoEnable) {
            await ctx.changes.apply(
              {
                kind: 'npm.enable',
                target: `NPM proxy host #${host.id} (${host.domain_names.join(', ')})`,
                message: `Enable proxy host on ${ctx.plan.target.name}`,
                before: { enabled: false },
                after: { enabled: true },
                siteId: ctx.plan.target.id,
                applicationId: app.id,
              },
              () => npm.enableProxyHost(host.id),
            );
            if (ctx.changes.dryRun) {
              lines.push({ ok: 'WARNING', text: `${label} disabled; would be enabled` });
              continue;
            }
            host = await npm.getProxyHost(exp.proxyHostId);
            mism = compareProxyHost(host, exp);
          }
          if (mism.length) {
            block(ctx, key, `${label} configuration mismatch: ${mism.map(describeMismatch).join('; ')}`, false);
            lines.push({ ok: 'FAIL', text: `${label} mismatch: ${mism.map(describeMismatch).join('; ')}` });
          } else {
            lines.push({ ok: 'PASS', text: `${label} → ${exp.forwardHost}:${exp.forwardPort} OK` });
          }
        } catch (e) {
          block(ctx, key, `${label} cannot be validated: ${errMsg(e)}`, false);
          lines.push({ ok: 'FAIL', text: `${label}: ${errMsg(e)}` });
        }
      }
    }
    return summarise(lines, { status: 'WARNING', message: 'No applications enabled' });
  },
};

const validateTunnel: StepDef = {
  key: 'validate_tunnel',
  name: 'Validate Cloudflare Tunnel',
  mutating: false,
  async run(ctx) {
    const { target, targetTunnel } = ctx.plan;
    if (!targetTunnel) return { status: 'WARNING', message: `No Cloudflare Tunnel mapped to ${target.name}` };
    try {
      const { provider, accountId } = await ctx.providers.cloudflare(targetTunnel.cloudflareAccountId);
      const t = await provider.getTunnel(accountId, targetTunnel.tunnelId);
      const conns = t.connections.filter((c) => !c.is_pending_reconnect).length;
      if (!((t.status === 'healthy' || t.status === 'degraded') && conns > 0)) {
        block(ctx, 'tunnel.down', `Tunnel ${targetTunnel.name} is ${t.status} with ${conns} connections`, false);
        return { status: 'FAIL', message: `Tunnel ${targetTunnel.name} ${t.status} (${conns} connections)` };
      }
      const cfg = await provider.getTunnelConfig(accountId, targetTunnel.tunnelId);
      const names = ctx.plan.apps.flatMap((a) => a.dnsRecords.map((r) => r.name));
      if (cfg.source !== 'cloudflare') {
        return { status: 'WARNING', message: `Tunnel ${targetTunnel.name} ${t.status} (${conns} connections); locally managed, ingress cannot be verified` };
      }
      const missing = names.filter((n) => !ingressCovers(cfg.ingress, n));
      if (missing.length) {
        block(ctx, 'tunnel.ingress', `Tunnel ${targetTunnel.name} has no ingress rule for ${missing.join(', ')}`, false);
        return { status: 'FAIL', message: `Tunnel ${targetTunnel.name} missing ingress for ${missing.join(', ')}`, details: { missing } };
      }
      return { status: t.status === 'healthy' ? 'PASS' : 'WARNING', message: `Tunnel ${targetTunnel.name} ${t.status} (${conns} connections), ingress covers ${names.length} hostname(s)` };
    } catch (e) {
      block(ctx, 'tunnel.unavailable', `Cannot verify tunnel ${targetTunnel.name}: ${errMsg(e)}`, false);
      return { status: 'FAIL', message: `Cannot verify tunnel ${targetTunnel.name}: ${errMsg(e)}` };
    }
  },
};

const validateDns: StepDef = {
  key: 'validate_dns',
  name: 'Validate DNS configuration',
  mutating: false,
  async run(ctx) {
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    const verified = new Set<string>();
    for (const { app, dnsRecords } of ctx.plan.apps) {
      if (!dnsRecords.length) {
        lines.push({ ok: 'WARNING', text: `${app.name}: no managed DNS records` });
        continue;
      }
      for (const rec of dnsRecords) {
        const key = `dns.${rec.name}`;
        try {
          const zone = await ctx.repos.zones.get(rec.zoneId);
          if (!zone) throw new Error('zone not found');
          const { provider } = await ctx.providers.cloudflare(zone.cloudflareAccountId);
          if (!verified.has(zone.cloudflareAccountId)) {
            await provider.verifyToken();
            verified.add(zone.cloudflareAccountId);
          }
          const live = await provider.getDnsRecord(zone.zoneId, rec.recordId);
          if (live.name !== rec.name || live.type !== rec.type) {
            block(ctx, key, `${rec.name}: Cloudflare record ${rec.recordId} is now ${live.type} ${live.name}; refusing to modify`, false);
            lines.push({ ok: 'FAIL', text: `${rec.name}: record identity changed` });
          } else if (live.content === rec.primaryContent) {
            lines.push({ ok: 'PASS', text: `${rec.name} ${rec.type} → ${rec.primaryContent} (will switch to ${rec.secondaryContent})` });
          } else if (live.content === rec.secondaryContent) {
            lines.push({ ok: 'WARNING', text: `${rec.name} already points to ${ctx.plan.target.name}` });
          } else {
            block(ctx, key, `${rec.name} currently points to ${live.content}, which is neither the primary nor the secondary target; refusing to modify`, false);
            lines.push({ ok: 'FAIL', text: `${rec.name} has unexpected content ${live.content}` });
          }
        } catch (e) {
          block(ctx, key, `${rec.name}: ${errMsg(e)}`, false);
          lines.push({ ok: 'FAIL', text: `${rec.name}: ${errMsg(e)}` });
        }
      }
    }
    return summarise(lines, { status: 'WARNING', message: 'No applications enabled' });
  },
};

const checkBlockers: StepDef = {
  key: 'check_blockers',
  name: 'Evaluate failover safety',
  mutating: false,
  async run(ctx) {
    const all = [...ctx.blockers.values()];
    const hard = all.filter((b) => !b.overridable);
    const unacked = all.filter((b) => b.overridable && !ctx.acknowledged.has(b.key));
    const acked = all.filter((b) => b.overridable && ctx.acknowledged.has(b.key));
    const details = { blockers: all, acknowledged: acked.map((b) => b.key) };
    if (hard.length) return { status: 'FAIL', message: `Failover NOT safe: ${hard.map((b) => b.message).join('; ')}`, details };
    if (unacked.length) return { status: 'FAIL', message: `Override required: ${unacked.map((b) => b.message).join('; ')}`, details };
    if (acked.length) return { status: 'WARNING', message: `Proceeding with acknowledged risks: ${acked.map((b) => b.key).join(', ')}`, details };
    return { status: 'PASS', message: `${ctx.plan.target.name} is safe to promote`, details };
  },
};

// ---------------------------------------------------------------- step 6
const promoteWorkloads: StepDef = {
  key: 'promote_workloads',
  name: 'Promote standby workloads',
  mutating: true,
  async run(ctx) {
    const lines: Array<{ ok: 'PASS' | 'WARNING' | 'FAIL'; text: string }> = [];
    for (const { app, targetWorkloads } of ctx.plan.apps) {
      for (const w of targetWorkloads) {
        if (await ctx.isCancelled()) return { status: 'FAIL', message: 'Cancelled by operator', details: { cancelled: true, items: lines } };
        const label = `${w.kind === 'lxc' ? 'CT' : 'VM'} ${w.vmid} (${w.expectedName}) on ${w.node}`;
        const pve = await ctx.providers.proxmox(w.proxmoxInstanceId);
        const g = await pve.guestStatus(w.node, w.vmid, w.kind);
        if (g.name !== w.expectedName) return { status: 'FAIL', message: `${label}: name is now "${g.name}"; refusing to start` };
        if (g.status === 'running') {
          lines.push({ ok: 'PASS', text: `${app.name} ${label} already running` });
          continue;
        }
        if (!w.allowStart) return { status: 'FAIL', message: `${label} is ${g.status} and start is not permitted` };
        try {
          await ctx.changes.apply(
            {
              kind: 'vm.start',
              target: label,
              message: `Start ${app.name} workload on ${ctx.plan.target.name}`,
              before: { status: g.status },
              after: { status: 'running' },
              siteId: ctx.plan.target.id,
              applicationId: app.id,
            },
            async () => {
              const upid = await pve.powerAction(w.node, w.vmid, w.kind, 'start');
              await pve.waitForTask(w.node, upid, ctx.plan.policy.serviceWaitTimeoutSeconds * 1000, ctx.pollMs);
              const after = await pve.guestStatus(w.node, w.vmid, w.kind);
              if (after.status !== 'running') throw new Error(`still ${after.status} after start task`);
            },
          );
          lines.push({ ok: 'PASS', text: ctx.dryRun ? `would start ${app.name} ${label}` : `${app.name} ${label} started` });
        } catch (e) {
          lines.push({ ok: 'FAIL', text: `${app.name} ${label} failed to start: ${errMsg(e)}` });
          return summarise(lines, { status: 'FAIL', message: '' });
        }
      }
    }
    const out = summarise(lines, { status: 'PASS', message: 'No workloads to promote' });
    return ctx.dryRun && lines.length ? { ...out, status: 'PLANNED' } : out;
  },
};

// ---------------------------------------------------------------- step 7
async function pollChecks(ctx: StepContext, checks: HealthCheck[], timeoutS: number) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const last = await Promise.all(checks.map(async (c) => ({ check: c, ...(await runCheck(c, ctx.checkDeps)) })));
    if (last.every((r) => r.ok || !r.check.critical)) return { ok: true, results: last };
    if (Date.now() >= deadline) return { ok: false, results: last };
    await ctx.sleep(ctx.pollMs);
  }
}

const waitServices: StepDef = {
  key: 'wait_services',
  name: 'Wait for applications on secondary',
  mutating: false,
  async run(ctx) {
    const checks = (await ctx.repos.healthChecks.list({ siteId: ctx.plan.target.id })).filter(
      (c) => c.enabled && c.category === 'application' && ctx.plan.apps.some((a) => a.app.id === c.applicationId),
    );
    if (!checks.length) return { status: 'WARNING', message: `No application checks configured for ${ctx.plan.target.name}; applications cannot be verified before switching traffic` };
    const { ok, results } = await pollChecks(ctx, checks, ctx.dryRun ? 0 : ctx.plan.policy.serviceWaitTimeoutSeconds);
    const items = results.map((r) => ({ ok: r.ok ? 'PASS' : r.check.critical ? 'FAIL' : 'WARNING', text: `${r.check.name}: ${r.message}` }));
    if (ok) return { status: items.some((i) => i.ok === 'WARNING') ? 'WARNING' : 'PASS', message: items.map((i) => i.text).join('; '), details: { items } };
    if (ctx.dryRun) {
      const stoppedVms = ctx.plan.apps.some((a) => a.targetWorkloads.some((w) => w.standbyState === 'stopped'));
      return {
        status: 'WARNING',
        message: `${stoppedVms ? 'Cold standby: some applications only respond after promotion. ' : ''}${items.filter((i) => i.ok !== 'PASS').map((i) => i.text).join('; ')}`,
        details: { items },
      };
    }
    return { status: 'FAIL', message: `Applications not healthy after ${ctx.plan.policy.serviceWaitTimeoutSeconds}s: ${items.filter((i) => i.ok === 'FAIL').map((i) => i.text).join('; ')}`, details: { items } };
  },
};

// ---------------------------------------------------------------- step 10
const updateDns: StepDef = {
  key: 'update_dns',
  name: 'Update Cloudflare DNS',
  mutating: true,
  async run(ctx) {
    const records = ctx.plan.apps.flatMap((a) => a.dnsRecords.map((r) => ({ app: a.app, rec: r })));
    ctx.dnsResults = records.map(({ rec }) => ({ name: rec.name, result: 'not_attempted' as const }));
    const setResult = (name: string, result: StepContext['dnsResults'][number]['result'], detail?: string) => {
      const r = ctx.dnsResults.find((x) => x.name === name);
      if (r) Object.assign(r, { result, detail });
    };
    for (const { app, rec } of records) {
      const zone = await ctx.repos.zones.get(rec.zoneId);
      if (!zone) {
        setResult(rec.name, 'failed', 'zone missing');
        return { status: 'FAIL', message: `${rec.name}: zone missing`, details: { records: ctx.dnsResults } };
      }
      try {
        const { provider } = await ctx.providers.cloudflare(zone.cloudflareAccountId);
        const live = await provider.getDnsRecord(zone.zoneId, rec.recordId);
        if (live.content === rec.secondaryContent) {
          setResult(rec.name, 'already');
          continue;
        }
        if (live.content !== rec.primaryContent || live.name !== rec.name || live.type !== rec.type) {
          setResult(rec.name, 'failed', `unexpected content ${live.content}`);
          return { status: 'FAIL', message: `${rec.name} points to ${live.content}, not the registered primary target; refusing to modify`, details: { records: ctx.dnsResults } };
        }
        await ctx.changes.apply(
          {
            kind: 'dns.update',
            target: rec.name,
            message: `Cloudflare DNS ${rec.type} ${rec.name}: ${rec.primaryContent} → ${rec.secondaryContent}`,
            before: { content: live.content, ttl: live.ttl, proxied: live.proxied },
            after: { content: rec.secondaryContent, ttl: rec.ttl, proxied: rec.proxied },
            siteId: ctx.plan.target.id,
            applicationId: app.id,
          },
          async () => {
            await provider.updateDnsRecord(zone.zoneId, rec.recordId, { content: rec.secondaryContent, ttl: rec.ttl, proxied: rec.proxied });
            const check = await provider.getDnsRecord(zone.zoneId, rec.recordId);
            if (check.content !== rec.secondaryContent) throw new Error(`verification read returned ${check.content}`);
          },
        );
        setResult(rec.name, ctx.dryRun ? 'planned' : 'updated');
        if (!ctx.dryRun) await ctx.repos.dnsRecords.update(rec.id, { lastVerifiedAt: new Date() });
      } catch (e) {
        setResult(rec.name, 'failed', errMsg(e));
        return {
          status: 'FAIL',
          message: `Cloudflare DNS update failed at ${rec.name}: ${errMsg(e)}. ${summariseDns(ctx)}`,
          details: { records: ctx.dnsResults },
        };
      }
    }
    if (!records.length) return { status: 'WARNING', message: 'No managed DNS records' };
    return { status: ctx.dryRun ? 'PLANNED' : 'PASS', message: summariseDns(ctx), details: { records: ctx.dnsResults } };
  },
};

function summariseDns(ctx: StepContext): string {
  const by = (r: string) => ctx.dnsResults.filter((x) => x.result === r).map((x) => x.name);
  const parts: string[] = [];
  if (by('planned').length) parts.push(`would update ${by('planned').join(', ')}`);
  if (by('updated').length) parts.push(`updated ${by('updated').join(', ')}`);
  if (by('already').length) parts.push(`already on secondary: ${by('already').join(', ')}`);
  if (by('failed').length) parts.push(`FAILED: ${by('failed').join(', ')}`);
  if (by('not_attempted').length) parts.push(`not attempted: ${by('not_attempted').join(', ')}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------- step 11
const waitPropagation: StepDef = {
  key: 'wait_propagation',
  name: 'Wait for routing propagation',
  mutating: true,
  async run(ctx) {
    if (ctx.dryRun) return { status: 'SKIPPED', message: `Would wait ${ctx.plan.policy.propagationWaitSeconds}s for Cloudflare propagation` };
    await ctx.sleep(ctx.plan.policy.propagationWaitSeconds * 1000);
    const unproxied = ctx.plan.apps.flatMap((a) => a.dnsRecords).filter((r) => !r.proxied);
    if (!unproxied.length) return { status: 'PASS', message: `Waited ${ctx.plan.policy.propagationWaitSeconds}s (all records proxied; Cloudflare edge applies changes directly)` };
    const pending: string[] = [];
    for (const r of unproxied) {
      try {
        const answers = await ctx.checkDeps.dns(r.name, r.type);
        if (!answers.map((a) => a.replace(/\.$/, '').toLowerCase()).includes(r.secondaryContent.toLowerCase())) pending.push(r.name);
      } catch {
        pending.push(r.name);
      }
    }
    return pending.length
      ? { status: 'WARNING', message: `Unproxied records not yet visible in public DNS (TTL/caching): ${pending.join(', ')}` }
      : { status: 'PASS', message: 'Public DNS shows the secondary targets' };
  },
};

// ---------------------------------------------------------------- step 12
const verifyTraffic: StepDef = {
  key: 'verify_traffic',
  name: 'Verify external traffic',
  mutating: true,
  async run(ctx) {
    const checks = (await ctx.repos.healthChecks.list({ siteId: ctx.plan.target.id })).filter((c) => c.enabled && c.category === 'traffic');
    if (!checks.length) {
      return { status: 'WARNING', message: `No traffic checks configured for ${ctx.plan.target.name}; cannot prove users are reaching it` };
    }
    if (ctx.dryRun) return { status: 'SKIPPED', message: `Runs after the DNS change: ${checks.map((c) => c.name).join(', ')}` };
    const { ok, results } = await pollChecks(ctx, checks, ctx.plan.policy.verifyTimeoutSeconds);
    const text = results.map((r) => `${r.check.name}: ${r.message}`).join('; ');
    return ok
      ? { status: 'PASS', message: `External HTTPS validation successful: ${text}` }
      : { status: 'FAIL', message: `Traffic not verified after ${ctx.plan.policy.verifyTimeoutSeconds}s: ${text}` };
  },
};

/** Read-only validation steps, also used as the preflight for an execute request. */
export const VALIDATION_STEPS: StepDef[] = [assessPrimary, checkSecondary, checkWorkloads, checkReplication, validateNpm, validateTunnel, validateDns, checkBlockers];

export const STEPS = {
  assessPrimary,
  checkSecondary,
  checkWorkloads,
  checkReplication,
  validateNpm,
  validateTunnel,
  validateDns,
  checkBlockers,
  promoteWorkloads,
  waitServices,
  updateDns,
  waitPropagation,
  verifyTraffic,
};

/** Same step under another key (re-validation after promotion). */
export const withKey = (step: StepDef, key: string, name: string): StepDef => ({ ...step, key, name });
