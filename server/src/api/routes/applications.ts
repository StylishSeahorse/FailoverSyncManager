import { Type } from 'typebox';
import { siteHealth } from '../../health/aggregate.js';
import { auditConfig, type Api, type ApiContext } from '../context.js';
import { badRequest, HttpProblem, notFound } from '../errors.js';

const Id = Type.Object({ id: Type.String() });
const Sub = Type.Object({ id: Type.String(), sid: Type.String() });

const AppBody = Type.Object({
  slug: Type.String({ pattern: '^[a-z0-9-]{1,48}$' }),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  failoverPriority: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  maxReplicationAgeSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 7 * 86400 })),
  enabled: Type.Optional(Type.Boolean()),
});

const WorkloadBody = Type.Object({
  siteId: Type.String(),
  proxmoxInstanceId: Type.String(),
  node: Type.String({ minLength: 1 }),
  vmid: Type.Integer({ minimum: 1 }),
  kind: Type.Optional(Type.Union([Type.Literal('qemu'), Type.Literal('lxc')])),
  standbyState: Type.Optional(Type.Union([Type.Literal('stopped'), Type.Literal('running')])),
  allowStart: Type.Optional(Type.Boolean()),
  allowStop: Type.Optional(Type.Boolean()),
  replicationSource: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('pve_replication'), Type.Literal('pve_backup')])),
  replicationVmid: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  backupStorage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  startOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
});

const DnsBody = Type.Object({
  zoneId: Type.String({ description: 'FSM zone id (from discovery)' }),
  recordId: Type.String({ description: 'Cloudflare record id (from discovery)' }),
  primaryContent: Type.String({ minLength: 1, maxLength: 255 }),
  secondaryContent: Type.String({ minLength: 1, maxLength: 255 }),
  ttl: Type.Optional(Type.Integer()),
  proxied: Type.Optional(Type.Boolean()),
  failoverPriority: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

const NpmExpBody = Type.Object({
  siteId: Type.String(),
  npmInstanceId: Type.String(),
  proxyHostId: Type.Integer({ minimum: 1 }),
  /** Copy domains/upstream from the live proxy host instead of specifying them. */
  fromLive: Type.Optional(Type.Boolean()),
  domainNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  forwardScheme: Type.Optional(Type.Union([Type.Literal('http'), Type.Literal('https')])),
  forwardHost: Type.Optional(Type.String({ minLength: 1 })),
  forwardPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  requireSsl: Type.Optional(Type.Boolean()),
  mustBeEnabled: Type.Optional(Type.Boolean()),
  allowAutoEnable: Type.Optional(Type.Boolean()),
});

export async function applicationRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;
  const app404 = async (id: string) => {
    const a = await s.repos.applications.get(id);
    if (!a) throw notFound('Application');
    return a;
  };

  api.get('/api/applications', { config: { role: 'viewer' }, schema: { tags: ['applications'] } }, async () => {
    const [apps, workloads, dns, npm] = await Promise.all([s.repos.applications.list(), s.repos.workloads.list(), s.repos.dnsRecords.list(), s.repos.npmExpectations.list()]);
    return apps.map((a) => ({
      ...a,
      workloads: workloads.filter((w) => w.applicationId === a.id),
      dnsRecords: dns.filter((d) => d.applicationId === a.id),
      npmExpectations: npm.filter((n) => n.applicationId === a.id),
    }));
  });

  api.post('/api/applications', { config: { role: 'admin' }, schema: { tags: ['applications'], body: AppBody } }, async (req, reply) => {
    const ctl = await s.store.controller();
    const app = await s.repos.applications.create({ ...req.body, activeSiteId: ctl.activeSiteId });
    await auditConfig(ctx, req, 'application.created', `Application ${app.name} created`);
    return reply.status(201).send(app);
  });

  api.patch('/api/applications/:id', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Id, body: Type.Partial(AppBody) } }, async (req) => {
    const before = await app404(req.params.id);
    const app = await s.repos.applications.update(before.id, req.body);
    await auditConfig(ctx, req, 'application.updated', `Application ${app!.name} updated`, { before, after: app });
    return app;
  });

  api.delete('/api/applications/:id', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Id } }, async (req) => {
    const app = await app404(req.params.id);
    await s.repos.applications.delete(app.id);
    await s.engine.reload();
    await auditConfig(ctx, req, 'application.deleted', `Application ${app.name} deleted`);
    return { ok: true };
  });

  api.get('/api/applications/:id/health', { config: { role: 'viewer' }, schema: { tags: ['applications'], params: Id } }, async (req) => {
    const app = await app404(req.params.id);
    const [sites, views] = await Promise.all([s.repos.sites.list(), s.engine.views()]);
    const perSite = sites.map((site) => {
      const h = siteHealth(site.id, views);
      return { siteId: site.id, site: site.name, application: h.applications[app.id] ?? null, replication: h.replication[app.id] ?? null };
    });
    return { application: app, perSite };
  });

  // ------------------------------------------------------------ workloads
  api.get('/api/applications/:id/workloads', { config: { role: 'viewer' }, schema: { tags: ['applications'], params: Id } }, async (req) => {
    await app404(req.params.id);
    return s.repos.workloads.list({ applicationId: req.params.id });
  });

  api.post('/api/applications/:id/workloads', { config: { role: 'admin' }, schema: { tags: ['applications'], summary: 'Register a protected VM/CT (verified against Proxmox)', params: Id, body: WorkloadBody } }, async (req, reply) => {
    const app = await app404(req.params.id);
    const inst = await s.repos.proxmox.get(req.body.proxmoxInstanceId);
    if (!inst || inst.siteId !== req.body.siteId) throw badRequest('Proxmox instance does not belong to that site');
    if (req.body.replicationSource === 'pve_backup' && !req.body.backupStorage) throw badRequest('backupStorage is required for pve_backup');
    const pve = await s.providers.proxmox(inst.id);
    const g = await pve.guestStatus(req.body.node, req.body.vmid, req.body.kind ?? 'qemu');
    if (!g.name) throw new HttpProblem(422, 'unverified', `Proxmox did not return a name for ${req.body.vmid}`);
    const w = await s.repos.workloads.create({ ...req.body, applicationId: app.id, expectedName: g.name });
    await auditConfig(ctx, req, 'workload.registered', `${app.name}: registered ${w.kind} ${w.vmid} (${w.expectedName}) on ${w.node}`, { allowStart: w.allowStart, allowStop: w.allowStop });
    return reply.status(201).send(w);
  });

  api.patch('/api/applications/:id/workloads/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub, body: Type.Partial(Type.Omit(WorkloadBody, ['siteId', 'proxmoxInstanceId', 'node', 'vmid', 'kind'])) } }, async (req) => {
    const w = await s.repos.workloads.get(req.params.sid);
    if (!w || w.applicationId !== req.params.id) throw notFound('Workload');
    const out = await s.repos.workloads.update(w.id, req.body);
    await auditConfig(ctx, req, 'workload.updated', `Workload ${w.vmid} updated`, { before: w, after: out });
    return out;
  });

  api.delete('/api/applications/:id/workloads/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub } }, async (req) => {
    const w = await s.repos.workloads.get(req.params.sid);
    if (!w || w.applicationId !== req.params.id) throw notFound('Workload');
    await s.repos.workloads.delete(w.id);
    await auditConfig(ctx, req, 'workload.removed', `Workload ${w.vmid} (${w.expectedName}) unregistered`);
    return { ok: true };
  });

  // ------------------------------------------------------------ DNS records
  api.get('/api/applications/:id/dns-records', { config: { role: 'viewer' }, schema: { tags: ['applications'], params: Id } }, async (req) => {
    await app404(req.params.id);
    return s.repos.dnsRecords.list({ applicationId: req.params.id });
  });

  api.post('/api/applications/:id/dns-records', { config: { role: 'admin' }, schema: { tags: ['applications'], summary: 'Put a discovered DNS record under failover control', params: Id, body: DnsBody } }, async (req, reply) => {
    const app = await app404(req.params.id);
    const zone = await s.repos.zones.get(req.body.zoneId);
    if (!zone) throw notFound('Zone');
    if (req.body.primaryContent === req.body.secondaryContent) throw badRequest('Primary and secondary targets must differ');
    const { provider } = await s.providers.cloudflare(zone.cloudflareAccountId);
    const live = await provider.getDnsRecord(zone.zoneId, req.body.recordId);
    if (!['A', 'AAAA', 'CNAME'].includes(live.type)) throw badRequest(`Record type ${live.type} cannot be managed`);
    if (live.content !== req.body.primaryContent && live.content !== req.body.secondaryContent) {
      throw new HttpProblem(422, 'content_mismatch', `${live.name} currently points to ${live.content}, which matches neither target`);
    }
    const ttl = req.body.ttl ?? live.ttl;
    const proxied = req.body.proxied ?? live.proxied;
    if (!(ttl === 1 || (ttl >= 30 && ttl <= 86400))) throw badRequest('ttl must be 1 (automatic) or 30-86400');
    const rec = await s.repos.dnsRecords.create({
      applicationId: app.id,
      zoneId: zone.id,
      recordId: live.id,
      name: live.name,
      type: live.type as 'A' | 'AAAA' | 'CNAME',
      primaryContent: req.body.primaryContent,
      secondaryContent: req.body.secondaryContent,
      ttl,
      proxied,
      failoverPriority: req.body.failoverPriority,
      lastVerifiedAt: new Date(),
    });
    await auditConfig(ctx, req, 'dns.managed', `${app.name}: ${rec.type} ${rec.name} is now managed (primary ${rec.primaryContent}, secondary ${rec.secondaryContent})`);
    return reply.status(201).send(rec);
  });

  api.patch('/api/applications/:id/dns-records/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub, body: Type.Partial(Type.Omit(DnsBody, ['zoneId', 'recordId'])) } }, async (req) => {
    const r = await s.repos.dnsRecords.get(req.params.sid);
    if (!r || r.applicationId !== req.params.id) throw notFound('DNS record');
    const out = await s.repos.dnsRecords.update(r.id, req.body);
    await auditConfig(ctx, req, 'dns.updated', `Managed record ${r.name} updated`, { before: r, after: out });
    return out;
  });

  api.delete('/api/applications/:id/dns-records/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub } }, async (req) => {
    const r = await s.repos.dnsRecords.get(req.params.sid);
    if (!r || r.applicationId !== req.params.id) throw notFound('DNS record');
    await s.repos.dnsRecords.delete(r.id);
    await auditConfig(ctx, req, 'dns.unmanaged', `${r.name} is no longer managed (record left unchanged in Cloudflare)`);
    return { ok: true };
  });

  // ------------------------------------------------------------ NPM expectations
  api.get('/api/applications/:id/npm-expectations', { config: { role: 'viewer' }, schema: { tags: ['applications'], params: Id } }, async (req) => {
    await app404(req.params.id);
    return s.repos.npmExpectations.list({ applicationId: req.params.id });
  });

  api.post('/api/applications/:id/npm-expectations', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Id, body: NpmExpBody } }, async (req, reply) => {
    const app = await app404(req.params.id);
    const inst = await s.repos.npm.get(req.body.npmInstanceId);
    if (!inst || inst.siteId !== req.body.siteId) throw badRequest('NPM instance does not belong to that site');
    const npm = await s.providers.npm(inst.id);
    const host = await npm.getProxyHost(req.body.proxyHostId);
    const b = req.body;
    const spec = b.fromLive
      ? { domainNames: host.domain_names, forwardScheme: host.forward_scheme, forwardHost: host.forward_host, forwardPort: host.forward_port }
      : { domainNames: b.domainNames, forwardScheme: b.forwardScheme, forwardHost: b.forwardHost, forwardPort: b.forwardPort };
    if (!spec.domainNames || !spec.forwardScheme || !spec.forwardHost || !spec.forwardPort) throw badRequest('Specify the expected configuration or set fromLive');
    const exp = await s.repos.npmExpectations.create({
      applicationId: app.id,
      siteId: b.siteId,
      npmInstanceId: inst.id,
      proxyHostId: host.id,
      domainNames: spec.domainNames,
      forwardScheme: spec.forwardScheme,
      forwardHost: spec.forwardHost,
      forwardPort: spec.forwardPort,
      requireSsl: b.requireSsl,
      mustBeEnabled: b.mustBeEnabled,
      allowAutoEnable: b.allowAutoEnable,
    });
    await auditConfig(ctx, req, 'npm.expectation_created', `${app.name}: expected NPM config for ${exp.domainNames.join(', ')} → ${exp.forwardHost}:${exp.forwardPort}`);
    return reply.status(201).send(exp);
  });

  api.patch('/api/applications/:id/npm-expectations/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub, body: Type.Partial(Type.Omit(NpmExpBody, ['siteId', 'npmInstanceId', 'fromLive'])) } }, async (req) => {
    const e = await s.repos.npmExpectations.get(req.params.sid);
    if (!e || e.applicationId !== req.params.id) throw notFound('NPM expectation');
    const out = await s.repos.npmExpectations.update(e.id, req.body);
    await auditConfig(ctx, req, 'npm.expectation_updated', `NPM expectation for ${e.domainNames.join(', ')} updated`, { before: e, after: out });
    return out;
  });

  api.delete('/api/applications/:id/npm-expectations/:sid', { config: { role: 'admin' }, schema: { tags: ['applications'], params: Sub } }, async (req) => {
    const e = await s.repos.npmExpectations.get(req.params.sid);
    if (!e || e.applicationId !== req.params.id) throw notFound('NPM expectation');
    await s.repos.npmExpectations.delete(e.id);
    await auditConfig(ctx, req, 'npm.expectation_deleted', `NPM expectation for ${e.domainNames.join(', ')} removed`);
    return { ok: true };
  });
}
