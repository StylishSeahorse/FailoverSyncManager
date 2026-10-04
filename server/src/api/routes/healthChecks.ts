import { Type } from 'typebox';
import { parseCheckConfig } from '../../health/checks/configs.js';
import type { CheckType, HealthCheck } from '../../domain/types.js';
import { auditConfig, type Api, type ApiContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';

const Id = Type.Object({ id: Type.String() });
const lit = <T extends string>(...v: T[]) => Type.Union(v.map((x) => Type.Literal(x)));

const CheckBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  siteId: Type.String(),
  applicationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  category: lit('network', 'infrastructure', 'application', 'tunnel', 'traffic', 'replication'),
  type: lit('icmp', 'tcp', 'http', 'dns', 'proxmox_api', 'proxmox_node', 'proxmox_vm', 'tunnel', 'npm_api', 'npm_proxy_host', 'replication'),
  path: Type.Optional(lit('sdwan', 'internet', 'cloudflare_api', 'local')),
  independenceGroup: Type.String({ minLength: 1, maxLength: 64 }),
  config: Type.Record(Type.String(), Type.Unknown()),
  intervalSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
  critical: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
});

const PolicyBody = Type.Object({
  automaticFailover: Type.Optional(Type.Boolean()),
  automaticFailback: Type.Optional(Type.Boolean()),
  consecutiveFailures: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  minimumFailureDurationSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
  recoveryConsecutiveSuccesses: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  requiredFailedGroups: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  requireNonSdwanFailure: Type.Optional(Type.Boolean()),
  minimumSecondaryHealth: Type.Optional(lit('HEALTHY', 'DEGRADED')),
  serviceWaitTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
  propagationWaitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 600 })),
  verifyTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
  circuitBreakerMaxFailovers: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  circuitBreakerWindowSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 7 * 86400 })),
});

export async function healthCheckRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;
  const validate = async (b: { type: CheckType; config: unknown; siteId: string; applicationId?: string | null; category: string }) => {
    try {
      parseCheckConfig(b.type, b.config);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!(await s.repos.sites.get(b.siteId))) throw notFound('Site');
    if (b.applicationId && !(await s.repos.applications.get(b.applicationId))) throw notFound('Application');
    if ((b.category === 'application' || b.category === 'replication') && !b.applicationId) throw badRequest(`${b.category} checks must belong to an application`);
  };

  api.get('/api/health-checks', { config: { role: 'viewer' }, schema: { tags: ['health'], querystring: Type.Object({ siteId: Type.Optional(Type.String()), applicationId: Type.Optional(Type.String()) }) } }, async (req) => {
    const [checks, states] = await Promise.all([s.repos.healthChecks.list({ siteId: req.query.siteId, applicationId: req.query.applicationId }), s.healthState.all()]);
    return checks.map((c) => ({ ...c, state: states.get(c.id) ?? null }));
  });

  api.post('/api/health-checks', { config: { role: 'admin' }, schema: { tags: ['health'], body: CheckBody } }, async (req, reply) => {
    await validate(req.body);
    const check = await s.repos.healthChecks.create(req.body as Partial<HealthCheck>);
    await s.engine.reload();
    await auditConfig(ctx, req, 'check.created', `Health check "${check.name}" created`, { type: check.type, category: check.category });
    return reply.status(201).send(check);
  });

  api.patch('/api/health-checks/:id', { config: { role: 'admin' }, schema: { tags: ['health'], params: Id, body: Type.Partial(CheckBody) } }, async (req) => {
    const cur = await s.repos.healthChecks.get(req.params.id);
    if (!cur) throw notFound('Health check');
    const merged = { ...cur, ...req.body };
    await validate(merged as Parameters<typeof validate>[0]);
    const check = await s.repos.healthChecks.update(cur.id, req.body as Partial<HealthCheck>);
    await s.engine.reload();
    await auditConfig(ctx, req, 'check.updated', `Health check "${check!.name}" updated`, { before: cur, after: check });
    return check;
  });

  api.delete('/api/health-checks/:id', { config: { role: 'admin' }, schema: { tags: ['health'], params: Id } }, async (req) => {
    const cur = await s.repos.healthChecks.get(req.params.id);
    if (!cur) throw notFound('Health check');
    await s.repos.healthChecks.delete(cur.id);
    await s.engine.reload();
    await auditConfig(ctx, req, 'check.deleted', `Health check "${cur.name}" deleted`);
    return { ok: true };
  });

  api.post('/api/health-checks/:id/run', { config: { role: 'operator' }, schema: { tags: ['health'], summary: 'Run once; not counted toward thresholds', params: Id } }, async (req) => {
    const check = await s.repos.healthChecks.get(req.params.id);
    if (!check) throw notFound('Health check');
    return s.engine.runOnce(check);
  });

  api.get('/api/health-checks/:id/results', { config: { role: 'viewer' }, schema: { tags: ['health'], params: Id, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }) } }, async (req) => {
    if (!(await s.repos.healthChecks.get(req.params.id))) throw notFound('Health check');
    return s.healthState.results(req.params.id, req.query.limit ?? 100);
  });

  api.get('/api/policies/active', { config: { role: 'viewer' }, schema: { tags: ['policy'] } }, async () => s.policies.active());

  api.put('/api/policies/active', { config: { role: 'admin' }, schema: { tags: ['policy'], body: PolicyBody } }, async (req) => {
    if (req.body.automaticFailover) throw badRequest('Automatic failover is not available until Phase 2');
    if (req.body.automaticFailback) throw badRequest('Automatic failback is not available until Phase 3');
    const before = await s.policies.active();
    const after = await s.policies.updateActive(req.body);
    await auditConfig(ctx, req, 'policy.updated', 'Failover policy updated', { before, after });
    return after;
  });
}
