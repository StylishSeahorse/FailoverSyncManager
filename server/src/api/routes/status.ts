import { Type } from 'typebox';
import { dimension, siteHealth } from '../../health/aggregate.js';
import { classifyAge } from '../../orchestrator/replication.js';
import type { Api, ApiContext } from '../context.js';

export async function statusRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;

  api.get('/api/system/status', { config: { role: 'viewer' }, schema: { tags: ['status'], summary: 'Everything the dashboard needs in one call' } }, async () => {
    const [ctl, sites, siteStates, views, apps, policy] = await Promise.all([
      s.store.controller(),
      s.repos.sites.list(),
      s.store.siteStates(),
      s.engine.views(),
      s.repos.applications.list(),
      s.policies.active(),
    ]);
    const readiness = await s.readiness.evaluate();
    const siteViews = sites.map((site) => {
      const h = siteHealth(site.id, views);
      const mine = views.filter((v) => v.check.siteId === site.id);
      return {
        id: site.id,
        code: site.code,
        name: site.name,
        designatedRole: site.designatedRole,
        hostsController: site.hostsController,
        active: site.id === ctl.activeSiteId,
        state: siteStates.get(site.id)?.state ?? null,
        stateReason: siteStates.get(site.id)?.reason ?? '',
        health: { site: h.site, tunnel: h.tunnel, traffic: h.traffic },
        providers: {
          proxmox: dimension(mine.filter((v) => v.check.type.startsWith('proxmox'))),
          npm: dimension(mine.filter((v) => v.check.type.startsWith('npm'))),
          tunnel: h.tunnel,
        },
      };
    });
    const tunnelChecks = views.filter((v) => v.check.type === 'tunnel' && v.check.enabled);
    const cfOk = tunnelChecks.some((v) => v.state.status === 'OK' || (v.state.lastMessage && !/Cloudflare API/.test(v.state.lastMessage) && v.state.status !== 'UNKNOWN'));
    const cfErr = tunnelChecks.find((v) => /Cloudflare API/.test(v.state.lastMessage));
    const cloudflare = !tunnelChecks.length
      ? { status: 'UNKNOWN', message: 'No tunnel checks configured' }
      : cfOk
        ? { status: 'CONNECTED', message: 'Cloudflare API reachable' }
        : { status: cfErr ? 'ERROR' : 'UNKNOWN', message: cfErr?.state.lastMessage ?? 'No results yet' };

    const allWorkloads = await s.repos.workloads.list();
    const applications = apps.map((app) => {
      const perSite = Object.fromEntries(
        sites.map((site) => {
          const h = siteHealth(site.id, views);
          return [site.id, h.applications[app.id] ?? { status: 'UNKNOWN', reasons: ['No application checks'], checks: [] }];
        }),
      );
      const standby = sites.find((x) => x.id !== (app.activeSiteId ?? ctl.activeSiteId));
      const rc = standby && views.find((v) => v.check.type === 'replication' && v.check.applicationId === app.id && v.check.siteId === standby.id);
      const age = rc && typeof rc.state.lastObserved?.ageSeconds === 'number' ? (rc.state.lastObserved.ageSeconds as number) : null;
      // A cold standby's application checks fail by design until failover starts its VMs.
      const standbyWorkloads = standby ? allWorkloads.filter((w) => w.applicationId === app.id && w.siteId === standby.id) : [];
      const standbyMode = !standbyWorkloads.length ? null : standbyWorkloads.every((w) => w.standbyState === 'stopped') ? 'cold' : 'warm';
      return {
        id: app.id,
        slug: app.slug,
        name: app.name,
        enabled: app.enabled,
        failoverPriority: app.failoverPriority,
        activeSiteId: app.activeSiteId ?? ctl.activeSiteId,
        standbySiteId: standby?.id ?? null,
        standbyMode,
        perSite,
        replication: { ageSeconds: age, maxAgeSeconds: app.maxReplicationAgeSeconds, safety: classifyAge(age, app.maxReplicationAgeSeconds), message: rc?.state.lastMessage ?? 'No replication check configured' },
      };
    });

    const running = ctl.currentOperationId ? await s.operations.get(ctl.currentOperationId) : null;
    const lastOps = await s.operations.list(1);
    const lastOp = running ?? lastOps[0] ?? null;
    return {
      controller: {
        failoverState: ctl.failoverState,
        activeSiteId: ctl.activeSiteId,
        currentOperationId: ctl.currentOperationId,
        monitoringPaused: ctl.monitoringPaused,
        circuitOpen: ctl.circuitOpen,
        updatedAt: ctl.updatedAt,
        automaticFailover: policy.automaticFailover,
      },
      sites: siteViews,
      cloudflare,
      applications,
      readiness,
      operation: lastOp ? { ...lastOp, steps: await s.operations.steps(lastOp.id) } : null,
      recentEvents: await s.audit.query({ limit: 25, severity: ['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'] }),
      serverTime: new Date(),
    };
  });

  api.get('/api/failover/status', { config: { role: 'viewer' }, schema: { tags: ['failover'] } }, async () => {
    const ctl = await s.store.controller();
    return {
      controller: ctl,
      operation: ctl.currentOperationId ? await s.operations.get(ctl.currentOperationId) : null,
      readiness: await s.readiness.evaluate(),
    };
  });

  api.get(
    '/api/failover/readiness',
    { config: { role: 'viewer' }, schema: { tags: ['failover'], summary: 'Can production safely move to the standby site right now?', querystring: Type.Object({ target: Type.Optional(Type.String()) }) } },
    async (req) => s.readiness.evaluate(req.query.target),
  );
}
