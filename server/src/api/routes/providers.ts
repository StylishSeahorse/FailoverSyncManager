import { Type } from 'typebox';
import type { CloudflareAccount, NpmInstance, ProxmoxInstance } from '../../domain/types.js';
import { SECRET_PURPOSE } from '../../providers/registry.js';
import { auditConfig, type Api, type ApiContext } from '../context.js';
import { badRequest, HttpProblem, notFound } from '../errors.js';

const Id = Type.Object({ id: Type.String() });
const Url = Type.String({ pattern: '^https?://[^\\s]+$', maxLength: 300 });

/** Secret fields are write-only: responses only say whether one is configured. */
const proxmoxView = (p: ProxmoxInstance) => ({
  id: p.id,
  siteId: p.siteId,
  name: p.name,
  baseUrl: p.baseUrl,
  tokenId: p.tokenId,
  tokenSecretConfigured: Boolean(p.tokenSecretId),
  tlsCaConfigured: Boolean(p.tlsCaPem),
  tlsInsecure: p.tlsInsecure,
});
const npmView = (n: NpmInstance) => ({
  id: n.id,
  siteId: n.siteId,
  name: n.name,
  baseUrl: n.baseUrl,
  identity: n.identity,
  passwordConfigured: Boolean(n.secretId),
  tlsCaConfigured: Boolean(n.tlsCaPem),
  tlsInsecure: n.tlsInsecure,
});
const cfView = (c: CloudflareAccount) => ({ id: c.id, name: c.name, accountId: c.accountId, baseUrl: c.baseUrl, apiTokenConfigured: Boolean(c.apiTokenSecretId) });

const ProxmoxBody = Type.Object({
  siteId: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  baseUrl: Url,
  tokenId: Type.String({ pattern: '^[^\\s!]+@[^\\s!]+![^\\s=]+$', description: 'user@realm!tokenname' }),
  tokenSecret: Type.Optional(Type.String({ minLength: 8, maxLength: 200, writeOnly: true })),
  tlsCaPem: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  tlsInsecure: Type.Optional(Type.Boolean()),
});
const NpmBody = Type.Object({
  siteId: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  baseUrl: Url,
  identity: Type.String({ minLength: 1, maxLength: 200 }),
  password: Type.Optional(Type.String({ minLength: 1, maxLength: 200, writeOnly: true })),
  tlsCaPem: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  tlsInsecure: Type.Optional(Type.Boolean()),
});
const CfBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  accountId: Type.String({ pattern: '^[a-zA-Z0-9]{1,64}$' }),
  apiToken: Type.Optional(Type.String({ minLength: 10, maxLength: 200, writeOnly: true })),
  baseUrl: Type.Optional(Url),
});

export async function providerRoutes(api: Api, ctx: ApiContext) {
  const { s } = ctx;
  const insecureWarning = async (req: Parameters<typeof auditConfig>[1], what: string, insecure: boolean | undefined) => {
    if (insecure) {
      await s.audit.write({ severity: 'WARNING', category: 'security', action: 'tls.insecure', message: `TLS verification disabled for ${what}`, actor: { type: 'user', id: req.user!.id, name: req.user!.username, ip: req.ip } });
    }
  };

  // ------------------------------------------------------------ Proxmox
  api.get('/api/proxmox-instances', { config: { role: 'viewer' }, schema: { tags: ['proxmox'] } }, async () => (await s.repos.proxmox.list()).map(proxmoxView));

  api.post('/api/proxmox-instances', { config: { role: 'admin' }, schema: { tags: ['proxmox'], body: ProxmoxBody } }, async (req, reply) => {
    const { tokenSecret, ...rest } = req.body;
    if (!tokenSecret) throw badRequest('tokenSecret is required');
    if (!(await s.repos.sites.get(rest.siteId))) throw notFound('Site');
    const secretId = await s.secrets.put(SECRET_PURPOSE.proxmox, tokenSecret);
    const inst = await s.repos.proxmox.create({ ...rest, tokenSecretId: secretId });
    await auditConfig(ctx, req, 'proxmox.created', `Proxmox instance ${inst.name} added`, { baseUrl: inst.baseUrl, tokenId: inst.tokenId });
    await insecureWarning(req, `Proxmox ${inst.name}`, inst.tlsInsecure);
    return reply.status(201).send(proxmoxView(inst));
  });

  api.patch('/api/proxmox-instances/:id', { config: { role: 'admin' }, schema: { tags: ['proxmox'], params: Id, body: Type.Partial(ProxmoxBody) } }, async (req) => {
    const cur = await s.repos.proxmox.get(req.params.id);
    if (!cur) throw notFound('Proxmox instance');
    const { tokenSecret, siteId: _site, ...rest } = req.body;
    let tokenSecretId = cur.tokenSecretId;
    if (tokenSecret) tokenSecretId = await s.secrets.put(SECRET_PURPOSE.proxmox, tokenSecret, cur.tokenSecretId);
    const inst = await s.repos.proxmox.update(cur.id, { ...rest, tokenSecretId });
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'proxmox.updated', `Proxmox instance ${inst!.name} updated${tokenSecret ? ' (token rotated)' : ''}`, { changed: Object.keys(req.body).filter((k) => k !== 'tokenSecret') });
    await insecureWarning(req, `Proxmox ${inst!.name}`, req.body.tlsInsecure);
    return proxmoxView(inst!);
  });

  api.delete('/api/proxmox-instances/:id', { config: { role: 'admin' }, schema: { tags: ['proxmox'], params: Id } }, async (req) => {
    const cur = await s.repos.proxmox.get(req.params.id);
    if (!cur) throw notFound('Proxmox instance');
    await s.repos.proxmox.delete(cur.id);
    if (cur.tokenSecretId) await s.secrets.delete(cur.tokenSecretId);
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'proxmox.deleted', `Proxmox instance ${cur.name} removed`);
    return { ok: true };
  });

  api.post('/api/proxmox-instances/:id/validate', { config: { role: 'operator' }, schema: { tags: ['proxmox'], params: Id } }, async (req) => {
    const pve = await s.providers.proxmox(req.params.id);
    const version = await pve.version();
    const nodes = await pve.listNodes();
    return { ok: nodes.every((n) => n.status === 'online'), version: version.version, nodes: nodes.map((n) => ({ node: n.node, status: n.status, cpu: n.cpu, mem: n.mem, maxmem: n.maxmem })) };
  });

  api.get('/api/proxmox-instances/:id/discover', { config: { role: 'admin' }, schema: { tags: ['proxmox'], params: Id } }, async (req) => {
    const pve = await s.providers.proxmox(req.params.id);
    const nodes = await pve.listNodes();
    const out = [];
    for (const n of nodes) {
      out.push({ node: n.node, status: n.status, guests: n.status === 'online' ? await pve.listGuests(n.node) : [], storage: n.status === 'online' ? await pve.listStorage(n.node) : [] });
    }
    return { nodes: out };
  });

  // ------------------------------------------------------------ NPM
  api.get('/api/npm-instances', { config: { role: 'viewer' }, schema: { tags: ['npm'] } }, async () => (await s.repos.npm.list()).map(npmView));

  api.post('/api/npm-instances', { config: { role: 'admin' }, schema: { tags: ['npm'], body: NpmBody } }, async (req, reply) => {
    const { password, ...rest } = req.body;
    if (!password) throw badRequest('password is required');
    if (!(await s.repos.sites.get(rest.siteId))) throw notFound('Site');
    const secretId = await s.secrets.put(SECRET_PURPOSE.npm, password);
    const inst = await s.repos.npm.create({ ...rest, secretId });
    await auditConfig(ctx, req, 'npm.created', `NPM instance ${inst.name} added`, { baseUrl: inst.baseUrl, identity: inst.identity });
    await insecureWarning(req, `NPM ${inst.name}`, inst.tlsInsecure);
    return reply.status(201).send(npmView(inst));
  });

  api.patch('/api/npm-instances/:id', { config: { role: 'admin' }, schema: { tags: ['npm'], params: Id, body: Type.Partial(NpmBody) } }, async (req) => {
    const cur = await s.repos.npm.get(req.params.id);
    if (!cur) throw notFound('NPM instance');
    const { password, siteId: _site, ...rest } = req.body;
    let secretId = cur.secretId;
    if (password) secretId = await s.secrets.put(SECRET_PURPOSE.npm, password, cur.secretId);
    const inst = await s.repos.npm.update(cur.id, { ...rest, secretId });
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'npm.updated', `NPM instance ${inst!.name} updated${password ? ' (password changed)' : ''}`, { changed: Object.keys(req.body).filter((k) => k !== 'password') });
    await insecureWarning(req, `NPM ${inst!.name}`, req.body.tlsInsecure);
    return npmView(inst!);
  });

  api.delete('/api/npm-instances/:id', { config: { role: 'admin' }, schema: { tags: ['npm'], params: Id } }, async (req) => {
    const cur = await s.repos.npm.get(req.params.id);
    if (!cur) throw notFound('NPM instance');
    await s.repos.npm.delete(cur.id);
    if (cur.secretId) await s.secrets.delete(cur.secretId);
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'npm.deleted', `NPM instance ${cur.name} removed`);
    return { ok: true };
  });

  api.post('/api/npm-instances/:id/validate', { config: { role: 'operator' }, schema: { tags: ['npm'], params: Id } }, async (req) => {
    const inst = await s.repos.npm.get(req.params.id);
    if (!inst) throw notFound('NPM instance');
    const npm = await s.providers.npm(inst.id);
    const status = await npm.status();
    const hosts = await npm.listProxyHosts();
    const { compareProxyHost, describeMismatch } = await import('../../providers/npm/NpmProvider.js');
    const expectations = (await s.repos.npmExpectations.list()).filter((e) => e.npmInstanceId === inst.id);
    const results = expectations.map((e) => {
      const host = hosts.find((h) => h.id === e.proxyHostId);
      if (!host) return { expectationId: e.id, domains: e.domainNames, ok: false, problems: ['proxy host not found'] };
      const m = compareProxyHost(host, e);
      return { expectationId: e.id, domains: e.domainNames, ok: !m.length, problems: m.map(describeMismatch) };
    });
    return { ok: status.status === 'OK' && results.every((r) => r.ok), version: status.version, proxyHosts: hosts.length, expectations: results };
  });

  api.get('/api/npm-instances/:id/discover', { config: { role: 'admin' }, schema: { tags: ['npm'], params: Id } }, async (req) => {
    const npm = await s.providers.npm(req.params.id);
    const [hosts, certificates] = await Promise.all([npm.listProxyHosts(), npm.listCertificates()]);
    return { proxyHosts: hosts, certificates };
  });

  // ------------------------------------------------------------ Cloudflare
  api.get('/api/cloudflare-accounts', { config: { role: 'viewer' }, schema: { tags: ['cloudflare'] } }, async () => (await s.repos.cloudflareAccounts.list()).map(cfView));

  api.post('/api/cloudflare-accounts', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], body: CfBody } }, async (req, reply) => {
    const { apiToken, ...rest } = req.body;
    if (!apiToken) throw badRequest('apiToken is required');
    const secretId = await s.secrets.put(SECRET_PURPOSE.cloudflare, apiToken);
    const acct = await s.repos.cloudflareAccounts.create({ ...rest, apiTokenSecretId: secretId });
    await auditConfig(ctx, req, 'cloudflare.created', `Cloudflare account ${acct.name} added`, { accountId: acct.accountId });
    return reply.status(201).send(cfView(acct));
  });

  api.patch('/api/cloudflare-accounts/:id', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], params: Id, body: Type.Partial(CfBody) } }, async (req) => {
    const cur = await s.repos.cloudflareAccounts.get(req.params.id);
    if (!cur) throw notFound('Cloudflare account');
    const { apiToken, ...rest } = req.body;
    let apiTokenSecretId = cur.apiTokenSecretId;
    if (apiToken) apiTokenSecretId = await s.secrets.put(SECRET_PURPOSE.cloudflare, apiToken, cur.apiTokenSecretId);
    const acct = await s.repos.cloudflareAccounts.update(cur.id, { ...rest, apiTokenSecretId });
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'cloudflare.updated', `Cloudflare account ${acct!.name} updated${apiToken ? ' (token rotated)' : ''}`);
    return cfView(acct!);
  });

  api.delete('/api/cloudflare-accounts/:id', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const cur = await s.repos.cloudflareAccounts.get(req.params.id);
    if (!cur) throw notFound('Cloudflare account');
    await s.repos.cloudflareAccounts.delete(cur.id);
    if (cur.apiTokenSecretId) await s.secrets.delete(cur.apiTokenSecretId);
    s.providers.invalidate(cur.id);
    await auditConfig(ctx, req, 'cloudflare.deleted', `Cloudflare account ${cur.name} removed`);
    return { ok: true };
  });

  api.post('/api/cloudflare-accounts/:id/validate', { config: { role: 'operator' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const { provider, accountId } = await s.providers.cloudflare(req.params.id);
    const token = await provider.verifyToken(accountId);
    const zones = await provider.listZones();
    return { ok: token.status === 'active', tokenStatus: token.status, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })) };
  });

  api.post('/api/cloudflare-accounts/:id/discover-zones', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const acct = await s.repos.cloudflareAccounts.get(req.params.id);
    if (!acct) throw notFound('Cloudflare account');
    const { provider } = await s.providers.cloudflare(acct.id);
    const zones = await provider.listZones();
    const existing = await s.repos.zones.list({ cloudflareAccountId: acct.id });
    for (const z of zones) {
      if (!existing.some((e) => e.zoneId === z.id)) await s.repos.zones.create({ cloudflareAccountId: acct.id, zoneId: z.id, name: z.name });
    }
    await auditConfig(ctx, req, 'cloudflare.zones_discovered', `Discovered ${zones.length} zone(s) for ${acct.name}`);
    return s.repos.zones.list({ cloudflareAccountId: acct.id });
  });

  api.get('/api/cloudflare-zones', { config: { role: 'viewer' }, schema: { tags: ['cloudflare'] } }, async () => s.repos.zones.list());

  api.get('/api/cloudflare-zones/:id/records', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const zone = await s.repos.zones.get(req.params.id);
    if (!zone) throw notFound('Zone');
    const { provider } = await s.providers.cloudflare(zone.cloudflareAccountId);
    const records = await provider.listDnsRecords(zone.zoneId);
    const managed = await s.repos.dnsRecords.list({ zoneId: zone.id });
    return records
      .filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
      .map((r) => ({ ...r, managedBy: managed.find((m) => m.recordId === r.id)?.applicationId ?? null }));
  });

  // ------------------------------------------------------------ Tunnels
  api.get('/api/tunnels', { config: { role: 'viewer' }, schema: { tags: ['cloudflare'] } }, async () => s.repos.tunnels.list());

  api.post(
    '/api/tunnels',
    { config: { role: 'admin' }, schema: { tags: ['cloudflare'], body: Type.Object({ siteId: Type.String(), cloudflareAccountId: Type.String(), tunnelId: Type.String({ pattern: '^[0-9a-fA-F-]{36}$' }) }) } },
    async (req, reply) => {
      if (!(await s.repos.sites.get(req.body.siteId))) throw notFound('Site');
      const { provider, accountId } = await s.providers.cloudflare(req.body.cloudflareAccountId);
      const t = await provider.getTunnel(accountId, req.body.tunnelId); // must exist; name comes from Cloudflare
      const row = await s.repos.tunnels.create({ ...req.body, name: t.name });
      await auditConfig(ctx, req, 'tunnel.mapped', `Tunnel ${t.name} mapped to site`, { tunnelId: t.id });
      return reply.status(201).send(row);
    },
  );

  api.delete('/api/tunnels/:id', { config: { role: 'admin' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const t = await s.repos.tunnels.get(req.params.id);
    if (!t) throw notFound('Tunnel');
    await s.repos.tunnels.delete(t.id);
    await auditConfig(ctx, req, 'tunnel.unmapped', `Tunnel ${t.name} unmapped`);
    return { ok: true };
  });

  api.post('/api/tunnels/:id/validate', { config: { role: 'operator' }, schema: { tags: ['cloudflare'], params: Id } }, async (req) => {
    const t = await s.repos.tunnels.get(req.params.id);
    if (!t) throw notFound('Tunnel');
    const { provider, accountId } = await s.providers.cloudflare(t.cloudflareAccountId);
    const [info, cfg] = await Promise.all([provider.getTunnel(accountId, t.tunnelId), provider.getTunnelConfig(accountId, t.tunnelId).catch((e: Error) => ({ source: 'unknown', ingress: [], error: e.message }))]);
    if (!info) throw new HttpProblem(502, 'provider_error', 'No tunnel info');
    return { status: info.status, connections: info.connections.length, configSource: cfg.source, ingress: cfg.ingress };
  });
}
