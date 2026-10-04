import type { CheckCategory, CheckStatus, HealthCheck, HealthCheckState } from '../domain/types.js';

export type DimensionStatus = 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';

export interface CheckView {
  check: HealthCheck;
  state: Pick<HealthCheckState, 'status' | 'lastMessage' | 'consecutiveFailures' | 'firstFailureAt' | 'lastResultAt'> & { lastObserved?: Record<string, unknown> };
}

export interface Dimension {
  status: DimensionStatus;
  reasons: string[];
  checks: Array<{ id: string; name: string; status: CheckStatus; message: string; critical: boolean }>;
}

const RANK: Record<DimensionStatus, number> = { HEALTHY: 0, UNKNOWN: 1, WARNING: 2, DEGRADED: 3, FAILED: 4 };

const fromCheck = (s: CheckStatus): DimensionStatus =>
  s === 'OK' ? 'HEALTHY' : s === 'UNKNOWN' ? 'UNKNOWN' : (s as DimensionStatus);

/** Worst status over the given checks; non-critical checks can only pull the dimension down to WARNING. */
export function dimension(views: CheckView[]): Dimension {
  const enabled = views.filter((v) => v.check.enabled);
  if (!enabled.length) return { status: 'UNKNOWN', reasons: ['No checks configured'], checks: [] };
  let worst: DimensionStatus = 'HEALTHY';
  const reasons: string[] = [];
  for (const v of enabled) {
    let s = fromCheck(v.state.status);
    if (!v.check.critical && RANK[s] > RANK.WARNING) s = 'WARNING';
    if (RANK[s] > RANK[worst]) worst = s;
    if (s !== 'HEALTHY') reasons.push(`${v.check.name}: ${v.state.status}${v.state.lastMessage ? ` (${v.state.lastMessage})` : ''}`);
  }
  // All unknown → unknown; any known healthy with others unknown → still flag unknown checks.
  if (worst === 'HEALTHY' && enabled.every((v) => v.state.status === 'UNKNOWN')) worst = 'UNKNOWN';
  return {
    status: worst,
    reasons,
    checks: enabled.map((v) => ({ id: v.check.id, name: v.check.name, status: v.state.status, message: v.state.lastMessage, critical: v.check.critical })),
  };
}

export interface SiteHealth {
  siteId: string;
  /** Network + infrastructure, site-scoped checks. */
  site: Dimension;
  tunnel: Dimension;
  traffic: Dimension;
  applications: Record<string, Dimension>;
  replication: Record<string, Dimension>;
}

const SITE_CATEGORIES: CheckCategory[] = ['network', 'infrastructure'];

export function siteHealth(siteId: string, views: CheckView[]): SiteHealth {
  const mine = views.filter((v) => v.check.siteId === siteId);
  const apps: Record<string, CheckView[]> = {};
  const repl: Record<string, CheckView[]> = {};
  for (const v of mine) {
    if (!v.check.applicationId) continue;
    if (v.check.category === 'application') (apps[v.check.applicationId] ??= []).push(v);
    if (v.check.category === 'replication') (repl[v.check.applicationId] ??= []).push(v);
  }
  return {
    siteId,
    site: dimension(mine.filter((v) => SITE_CATEGORIES.includes(v.check.category) && !v.check.applicationId)),
    tunnel: dimension(mine.filter((v) => v.check.category === 'tunnel')),
    traffic: dimension(mine.filter((v) => v.check.category === 'traffic')),
    applications: Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, dimension(v)])),
    replication: Object.fromEntries(Object.entries(repl).map(([k, v]) => [k, dimension(v)])),
  };
}

export interface ConfirmationPolicy {
  requiredFailedGroups: number;
  requireNonSdwanFailure: boolean;
}

export type MonitorLevel = 'HEALTHY' | 'DEGRADED' | 'FAILURE_DETECTED' | 'CONFIRMING' | 'CONFIRMED';

export interface Confirmation {
  level: MonitorLevel;
  confirmed: boolean;
  failedGroups: string[];
  failingGroups: string[];
  healthyGroups: string[];
  reasons: string[];
}

/**
 * Decides whether a site is genuinely down, counting *independent groups*
 * rather than raw checks. A group counts as failed only when every critical
 * check in it is FAILED. Replication checks never count: stale data is not an
 * outage.
 */
export function confirmSiteFailure(siteLabel: string, siteId: string, views: CheckView[], policy: ConfirmationPolicy): Confirmation {
  const relevant = views.filter((v) => v.check.siteId === siteId && v.check.enabled && v.check.critical && v.check.category !== 'replication');
  const groups = new Map<string, CheckView[]>();
  for (const v of relevant) (groups.get(v.check.independenceGroup) ?? groups.set(v.check.independenceGroup, []).get(v.check.independenceGroup)!).push(v);

  const failedGroups: string[] = [];
  const failingGroups: string[] = [];
  const healthyGroups: string[] = [];
  const nonSdwanFailed: string[] = [];
  const nonSdwanHealthy: string[] = [];
  const nonSdwanFailing: string[] = [];
  let anyWarning = false;
  let anyFailedCheck = false;

  for (const [g, vs] of groups) {
    const statuses = vs.map((v) => v.state.status);
    const offSdwan = vs.some((v) => v.check.path !== 'sdwan');
    if (statuses.every((s) => s === 'FAILED')) {
      failedGroups.push(g);
      if (offSdwan) nonSdwanFailed.push(g);
    } else if (statuses.every((s) => s === 'FAILED' || s === 'DEGRADED')) {
      failingGroups.push(g);
      if (offSdwan) nonSdwanFailing.push(g);
    } else if (statuses.every((s) => s === 'OK')) {
      healthyGroups.push(g);
      if (offSdwan) nonSdwanHealthy.push(g);
    }
    if (statuses.some((s) => s === 'WARNING' || s === 'DEGRADED')) anyWarning = true;
    if (statuses.some((s) => s === 'FAILED')) anyFailedCheck = true;
  }

  const reasons: string[] = [];
  const need = policy.requiredFailedGroups;
  const enoughGroups = failedGroups.length >= need;
  const offPathOk = !policy.requireNonSdwanFailure || nonSdwanFailed.length > 0;
  const confirmed = enoughGroups && offPathOk;

  if (failedGroups.length) reasons.push(`${siteLabel} ${failedGroups.join(' + ')} checks failed (${failedGroups.length} independent group${failedGroups.length > 1 ? 's' : ''}, ${need} required)`);
  if (failingGroups.length) reasons.push(`${siteLabel} ${failingGroups.join(' + ')} checks failing, waiting for minimum failure duration`);
  if (enoughGroups && !offPathOk) {
    reasons.push(
      `${siteLabel} only fails over the SD-WAN path; no failure seen via internet or Cloudflare${nonSdwanHealthy.length ? ` (${nonSdwanHealthy.join(', ')} still healthy)` : ''}. Failover NOT recommended`,
    );
  }
  if (confirmed) reasons.push(`${siteLabel} failure confirmed`);

  let level: MonitorLevel;
  if (confirmed) level = 'CONFIRMED';
  else if (
    failedGroups.length + failingGroups.length >= need &&
    (!policy.requireNonSdwanFailure || nonSdwanFailed.length + nonSdwanFailing.length > 0)
  )
    level = 'CONFIRMING';
  else if (anyFailedCheck || failingGroups.length) level = 'FAILURE_DETECTED';
  else if (anyWarning) level = 'DEGRADED';
  else level = 'HEALTHY';

  return { level, confirmed, failedGroups, failingGroups, healthyGroups, reasons };
}
