import type { Application, DnsRecord, NpmExpectation, Policy, Site, Tunnel, Workload } from '../domain/types.js';
import type { Repos } from '../repos/index.js';

export interface AppPlan {
  app: Application;
  /** Workloads at the target site, in start order. */
  targetWorkloads: Workload[];
  dnsRecords: DnsRecord[];
  targetNpm: NpmExpectation[];
}

export interface FailoverPlan {
  source: Site;
  target: Site;
  policy: Policy;
  apps: AppPlan[];
  targetTunnel: Tunnel | null;
}

/** Loads everything an operation needs about the applications it moves, in failover priority order. */
export async function loadPlan(repos: Repos, source: Site, target: Site, policy: Policy): Promise<FailoverPlan> {
  const apps = (await repos.applications.list()).filter((a) => a.enabled);
  const out: AppPlan[] = [];
  for (const app of apps) {
    const [workloads, dns, npm] = await Promise.all([
      repos.workloads.list({ applicationId: app.id, siteId: target.id }),
      repos.dnsRecords.list({ applicationId: app.id }),
      repos.npmExpectations.list({ applicationId: app.id, siteId: target.id }),
    ]);
    out.push({ app, targetWorkloads: workloads, dnsRecords: dns, targetNpm: npm });
  }
  const tunnels = await repos.tunnels.list({ siteId: target.id });
  return { source, target, policy, apps: out, targetTunnel: tunnels[0] ?? null };
}

export const confirmationPhrase = (target: Site) => `FAILOVER TO ${target.name.toUpperCase()}`;
