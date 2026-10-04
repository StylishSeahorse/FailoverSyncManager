import { Type } from 'typebox';
import { actorOf, isAdmin, type Api, type ApiContext } from '../context.js';
import { HttpProblem, notFound } from '../errors.js';

const Target = Type.Object({ targetSiteId: Type.String() });
const notYet = (phase: number, what: string) => new HttpProblem(501, 'not_implemented', `${what} arrives in Phase ${phase}`);

export async function failoverRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;

  api.post(
    '/api/failover/prepare',
    { config: { role: 'operator' }, schema: { tags: ['failover'], summary: 'Live, read-only readiness evaluation; returns blockers and the confirmation phrase', body: Target } },
    async (req) => s.orchestrator.prepare(req.body.targetSiteId, actorOf(req)),
  );

  api.post('/api/failover/test', { config: { role: 'operator' }, schema: { tags: ['failover'], summary: 'Start a dry run (Test Failover)', body: Target } }, async (req, reply) => {
    const op = await s.orchestrator.startDryRun(req.body.targetSiteId, actorOf(req));
    return reply.status(202).send(op);
  });

  api.post(
    '/api/failover/execute',
    {
      config: { role: 'operator' },
      schema: {
        tags: ['failover'],
        summary: 'Failover Now. Overrides (acknowledge) require admin and a reason',
        body: Type.Object({
          targetSiteId: Type.String(),
          confirm: Type.String({ description: 'Exact confirmation phrase returned by prepare' }),
          acknowledge: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
          reason: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
      },
    },
    async (req, reply) => {
      const op = await s.orchestrator.execute({ ...req.body, actor: actorOf(req), canOverride: isAdmin(req) });
      return reply.status(202).send(op);
    },
  );

  api.post('/api/failover/cancel', { config: { role: 'operator' }, schema: { tags: ['failover'] } }, async (req) => s.orchestrator.cancel(actorOf(req)));
  api.post('/api/failover/reconcile', { config: { role: 'operator' }, schema: { tags: ['failover'], summary: 'Set controller state from actual DNS' } }, async (req) => s.orchestrator.reconcile(actorOf(req)));

  api.post('/api/monitoring/pause', { config: { role: 'operator' }, schema: { tags: ['monitoring'] } }, async (req) => {
    await s.store.setMonitoringPaused(true, actorOf(req));
    s.engine.setPaused(true);
    return { monitoringPaused: true };
  });
  api.post('/api/monitoring/resume', { config: { role: 'operator' }, schema: { tags: ['monitoring'] } }, async (req) => {
    await s.store.setMonitoringPaused(false, actorOf(req));
    s.engine.setPaused(false);
    return { monitoringPaused: false };
  });

  api.get('/api/operations', { config: { role: 'viewer' }, schema: { tags: ['failover'], querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } }, async (req) =>
    s.operations.list(req.query.limit ?? 50),
  );
  api.get('/api/operations/:id', { config: { role: 'viewer' }, schema: { tags: ['failover'], params: Type.Object({ id: Type.String() }) } }, async (req) => {
    const op = await s.operations.get(req.params.id);
    if (!op) throw notFound('Operation');
    return { ...op, steps: await s.operations.steps(op.id) };
  });

  for (const path of ['/api/failback/prepare', '/api/failback/execute']) {
    api.post(path, { config: { role: 'operator' }, schema: { tags: ['failback'] } }, async () => {
      throw notYet(3, 'Controlled failback');
    });
  }
  for (const path of ['/api/maintenance/enable', '/api/maintenance/disable']) {
    api.post(path, { config: { role: 'operator' }, schema: { tags: ['maintenance'] } }, async () => {
      throw notYet(2, 'Maintenance mode');
    });
  }
}
