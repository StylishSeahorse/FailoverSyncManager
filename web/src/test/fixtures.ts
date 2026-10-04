import type { Dimension, PreflightReport, Readiness, SystemStatus } from '../api/types';

const healthy: Dimension = { status: 'HEALTHY', reasons: [], checks: [] };

export const readyReadiness: Readiness = {
  question: 'If Site A disappeared right now, can I safely move production to Site B?',
  ready: true,
  verdict: 'FAILOVER READY',
  sourceSiteId: 'a',
  targetSiteId: 'b',
  items: [
    { key: 'site.health', group: 'site', status: 'PASS', message: 'Site B site checks healthy' },
    { key: 'replication.nextcloud', group: 'replication', status: 'PASS', message: 'Nextcloud replication age: 4 min' },
  ],
  estimatedMaxDataLossSeconds: 240,
  primary: { level: 'HEALTHY', reasons: [] },
  evaluatedAt: '2026-10-04T08:00:00Z',
};

export const notSafeReadiness: Readiness = {
  ...readyReadiness,
  ready: false,
  verdict: 'FAILOVER NOT SAFE',
  items: [...readyReadiness.items.slice(0, 1), { key: 'replication.nextcloud', group: 'replication', status: 'FAIL', message: 'Nextcloud replication is 3.0 h old (limit 15 min)' }],
};

export function status(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    controller: { failoverState: 'HEALTHY_PRIMARY', activeSiteId: 'a', currentOperationId: null, monitoringPaused: false, circuitOpen: false, updatedAt: '2026-10-04T08:00:00Z', automaticFailover: false },
    sites: [
      { id: 'a', code: 'A', name: 'Site A', designatedRole: 'primary', hostsController: false, active: true, state: 'PRIMARY', stateReason: '', health: { site: healthy, tunnel: healthy, traffic: healthy }, providers: { proxmox: healthy, npm: healthy, tunnel: healthy } },
      { id: 'b', code: 'B', name: 'Site B', designatedRole: 'secondary', hostsController: true, active: false, state: 'SECONDARY', stateReason: '', health: { site: healthy, tunnel: healthy, traffic: healthy }, providers: { proxmox: healthy, npm: healthy, tunnel: healthy } },
    ],
    cloudflare: { status: 'CONNECTED', message: 'Cloudflare API reachable' },
    applications: [
      { id: 'app1', slug: 'nextcloud', name: 'Nextcloud', enabled: true, failoverPriority: 100, activeSiteId: 'a', standbySiteId: 'b', standbyMode: 'cold', perSite: { a: healthy, b: healthy }, replication: { ageSeconds: 240, maxAgeSeconds: 900, safety: 'SAFE', message: 'ok' } },
    ],
    readiness: readyReadiness,
    operation: null,
    recentEvents: [],
    serverTime: '2026-10-04T08:00:00Z',
    ...over,
  };
}

export function preflight(over: Partial<PreflightReport> = {}): PreflightReport {
  return {
    sourceSiteId: 'a',
    targetSiteId: 'b',
    verdict: 'READY FOR FAILOVER',
    steps: [{ key: 'check_secondary', name: 'Check secondary site', status: 'PASS', message: 'Site B healthy' }],
    blockers: [],
    overridable: [],
    estimatedMaxDataLossSeconds: 240,
    confirmationPhrase: 'FAILOVER TO SITE B',
    ...over,
  };
}
