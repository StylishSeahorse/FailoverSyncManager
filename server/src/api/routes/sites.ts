import { Type } from 'typebox';
import { siteHealth } from '../../health/aggregate.js';
import { auditConfig, type Api, type ApiContext } from '../context.js';
import { HttpProblem, notFound } from '../errors.js';

const Id = Type.Object({ id: Type.String() });
const SiteBody = Type.Object({
  code: Type.String({ pattern: '^[A-Z0-9]{1,8}$' }),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  designatedRole: Type.Union([Type.Literal('primary'), Type.Literal('secondary')]),
  hostsController: Type.Optional(Type.Boolean()),
});

export async function siteRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;

  api.get('/api/sites', { config: { role: 'viewer' }, schema: { tags: ['sites'] } }, async () => {
    const [sites, states, ctl] = await Promise.all([s.repos.sites.list(), s.store.siteStates(), s.store.controller()]);
    return sites.map((x) => ({ ...x, state: states.get(x.id)?.state ?? null, stateReason: states.get(x.id)?.reason ?? '', active: x.id === ctl.activeSiteId }));
  });

  api.post('/api/sites', { config: { role: 'admin' }, schema: { tags: ['sites'], body: SiteBody } }, async (req, reply) => {
    const existing = await s.repos.sites.list();
    if (existing.length >= 2) throw new HttpProblem(409, 'site_limit', 'This controller manages exactly two sites');
    const site = await s.repos.sites.create(req.body);
    await s.store.ensureInitialised(await s.repos.sites.list());
    await s.engine.reload();
    await auditConfig(ctx, req, 'site.created', `Site ${site.name} (${site.code}) created as ${site.designatedRole}`);
    return reply.status(201).send(site);
  });

  api.patch('/api/sites/:id', { config: { role: 'admin' }, schema: { tags: ['sites'], params: Id, body: Type.Partial(SiteBody) } }, async (req) => {
    const before = await s.repos.sites.get(req.params.id);
    if (!before) throw notFound('Site');
    if (req.body.designatedRole && req.body.designatedRole !== before.designatedRole) {
      throw new HttpProblem(409, 'role_change', 'Designated roles cannot be changed in place; failover/failback changes which site is active');
    }
    const site = await s.repos.sites.update(req.params.id, req.body);
    await s.engine.reload();
    await auditConfig(ctx, req, 'site.updated', `Site ${site!.name} updated`, { before, after: site });
    return site;
  });

  api.delete('/api/sites/:id', { config: { role: 'admin' }, schema: { tags: ['sites'], params: Id } }, async (req) => {
    const site = await s.repos.sites.get(req.params.id);
    if (!site) throw notFound('Site');
    const ctl = await s.store.controller();
    if (ctl.activeSiteId === site.id) throw new HttpProblem(409, 'active_site', 'The active site cannot be deleted');
    await s.repos.sites.delete(site.id);
    await s.engine.reload();
    await auditConfig(ctx, req, 'site.deleted', `Site ${site.name} deleted`);
    return { ok: true };
  });

  api.get('/api/sites/:id/health', { config: { role: 'viewer' }, schema: { tags: ['sites'], params: Id } }, async (req) => {
    const site = await s.repos.sites.get(req.params.id);
    if (!site) throw notFound('Site');
    return siteHealth(site.id, await s.engine.views());
  });

  api.post('/api/sites/:id/validate', { config: { role: 'operator' }, schema: { tags: ['sites'], summary: 'Run every check for the site now', params: Id } }, async (req) => {
    const site = await s.repos.sites.get(req.params.id);
    if (!site) throw notFound('Site');
    const results = await s.engine.runSite(site.id);
    await s.audit.write({ severity: 'INFO', category: 'health', action: 'site.validated', message: `${site.name} validated by ${req.user!.username}: ${results.filter((r) => r.result.ok).length}/${results.length} checks passed`, actor: { type: 'user', id: req.user!.id, name: req.user!.username, ip: req.ip }, siteId: site.id });
    return {
      site: site.name,
      results: results.map((r) => ({ checkId: r.check.id, name: r.check.name, category: r.check.category, ok: r.result.ok, message: r.result.message, latencyMs: r.result.latencyMs, status: r.state.status })),
      health: siteHealth(site.id, await s.engine.views()),
    };
  });
}
