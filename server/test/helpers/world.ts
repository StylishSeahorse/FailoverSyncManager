import { createServices, type Services } from '../../src/container.js';
import type { Application, Site } from '../../src/domain/types.js';
import { SECRET_PURPOSE } from '../../src/providers/registry.js';
import { tunnelCname } from '../../src/providers/cloudflare/CloudflareProvider.js';
import { FakeApp } from '../fakes/FakeApp.js';
import { FakeCloudflare } from '../fakes/FakeCloudflare.js';
import { FakeNpm } from '../fakes/FakeNpm.js';
import { FakeProxmox } from '../fakes/FakeProxmox.js';
import { FakeServer } from '../fakes/FakeServer.js';
import { createTestDb, type TestDb } from './db.js';

export const TUN_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
export const TUN_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

interface AppSpec {
  slug: string;
  name: string;
  host: string;
  vmA: number;
  vmB: number;
  path: string;
  marker: string;
}

const APPS: AppSpec[] = [
  { slug: 'wordpress', name: 'WordPress', host: 'www.example.com', vmA: 120, vmB: 220, path: '/wp-login.php', marker: 'wp-submit' },
  { slug: 'nextcloud', name: 'Nextcloud', host: 'cloud.example.com', vmA: 130, vmB: 230, path: '/status.php', marker: '"installed":true' },
  { slug: 'invoiceninja', name: 'Invoice Ninja', host: 'invoices.example.com', vmA: 140, vmB: 240, path: '/health', marker: 'ok' },
];

/**
 * A complete two-site deployment against fake Cloudflare, Proxmox, NPM and
 * application endpoints, with a fake Cloudflare "edge" that routes public
 * requests according to the fake DNS records, like the real thing.
 */
export class World {
  t!: TestDb;
  s!: Services;
  cf = new FakeCloudflare();
  pveA = new FakeProxmox('pve-a');
  pveB = new FakeProxmox('pve-b');
  npmA = new FakeNpm();
  npmB = new FakeNpm();
  appA = new FakeApp('site-a');
  appB = new FakeApp('site-b');
  edge: FakeServer;
  siteA!: Site;
  siteB!: Site;
  apps: Application[] = [];
  siteAUp = true;
  /** Controller's private (SD-WAN) path to Site A. */
  sdwanUp = true;
  readonly specs: AppSpec[];

  constructor(appCount = 3) {
    this.specs = APPS.slice(0, appCount);
    this.edge = new FakeServer((req) => {
      const host = String(req.headers.host ?? '').split(':')[0]!;
      const rec = this.cf.record(host);
      const spec = this.specs.find((s) => s.host === host);
      if (!rec || !spec) return { status: 404, body: 'no such zone' };
      const viaA = rec.content === tunnelCname(TUN_A);
      const viaB = rec.content === tunnelCname(TUN_B);
      const tunnelUp = viaA ? this.cf.tunnels.get(TUN_A)?.status === 'healthy' : viaB ? this.cf.tunnels.get(TUN_B)?.status === 'healthy' : false;
      if (!tunnelUp) return { status: 530, body: 'error 1033: Argo Tunnel error' };
      const appUp = viaA ? this.siteAUp && !this.appA.down : this.vmRunning(this.pveB, spec.vmB);
      if (!appUp) return { status: 502, body: 'Bad gateway' };
      return { status: 200, body: `<html>${spec.marker}</html>`, headers: { 'x-served-by': viaA ? 'site-a' : 'site-b', 'content-type': 'text/html' } };
    });
  }

  private vmRunning(pve: FakeProxmox, vmid: number) {
    return pve.guest(vmid)?.status === 'running';
  }

  async start(opts: { secondaryRunning?: boolean } = {}) {
    await Promise.all([this.cf, this.pveA, this.pveB, this.npmA, this.npmB, this.appA, this.appB, this.edge].map((f) => f.start()));
    this.t = await createTestDb();
    this.s = createServices({
      db: this.t.db,
      masterKey: Buffer.alloc(32, 5),
      egressAllowlist: ['127.0.0.1', 'localhost'],
      ping: async () => ({ alive: this.siteAUp && this.sdwanUp, timeMs: 1 }),
      dns: async () => [],
      providerTimeoutMs: 1500,
      retryDelayMs: 5,
      pollMs: 20,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    });
    await this.seed(opts.secondaryRunning ?? false);
    await this.s.initialise();
    return this;
  }

  async stop() {
    await this.s?.close();
    await this.t?.close();
    await Promise.all([this.cf, this.pveA, this.pveB, this.npmA, this.npmB, this.appA, this.appB, this.edge].map((f) => f.stop()));
  }

  private async seed(secondaryRunning: boolean) {
    const { repos, secrets, policies } = this.s;
    await policies.updateActive({
      consecutiveFailures: 2,
      minimumFailureDurationSeconds: 0,
      recoveryConsecutiveSuccesses: 2,
      requiredFailedGroups: 3,
      requireNonSdwanFailure: true,
      serviceWaitTimeoutSeconds: 3,
      propagationWaitSeconds: 0,
      verifyTimeoutSeconds: 3,
    });
    this.siteA = await repos.sites.create({ code: 'A', name: 'Site A', designatedRole: 'primary' });
    this.siteB = await repos.sites.create({ code: 'B', name: 'Site B', designatedRole: 'secondary', hostsController: true });

    const cfToken = await secrets.put(SECRET_PURPOSE.cloudflare, this.cf.token);
    const acct = await repos.cloudflareAccounts.create({ name: 'main', accountId: this.cf.accountId, apiTokenSecretId: cfToken, baseUrl: `${this.cf.url}/client/v4` });
    const zone = await repos.zones.create({ cloudflareAccountId: acct.id, zoneId: 'zone1', name: 'example.com' });
    const hosts = this.specs.map((s) => s.host);
    this.cf.addTunnel(TUN_A, 'tunnel-a', hosts);
    this.cf.addTunnel(TUN_B, 'tunnel-b', hosts);
    const tA = await repos.tunnels.create({ siteId: this.siteA.id, cloudflareAccountId: acct.id, tunnelId: TUN_A, name: 'tunnel-a' });
    const tB = await repos.tunnels.create({ siteId: this.siteB.id, cloudflareAccountId: acct.id, tunnelId: TUN_B, name: 'tunnel-b' });

    const pveInst = async (site: Site, fake: FakeProxmox) =>
      repos.proxmox.create({ siteId: site.id, name: fake.nodeName, baseUrl: fake.url, tokenId: fake.tokenId, tokenSecretId: await secrets.put(SECRET_PURPOSE.proxmox, fake.tokenSecret) });
    const pA = await pveInst(this.siteA, this.pveA);
    const pB = await pveInst(this.siteB, this.pveB);
    const npmInst = async (site: Site, fake: FakeNpm, name: string) =>
      repos.npm.create({ siteId: site.id, name, baseUrl: fake.url, identity: fake.identity, secretId: await secrets.put(SECRET_PURPOSE.npm, fake.secret) });
    const nA = await npmInst(this.siteA, this.npmA, 'npm-a');
    const nB = await npmInst(this.siteB, this.npmB, 'npm-b');

    const now = Math.floor(Date.now() / 1000);
    const port = (url: string) => Number(new URL(url).port);
    const check = (o: Parameters<typeof repos.healthChecks.create>[0]) => repos.healthChecks.create({ intervalSeconds: 3600, timeoutMs: 1000, ...o });

    // Site A (primary) site-level checks: independent groups over different paths.
    await check({ name: 'Proxmox A API', siteId: this.siteA.id, category: 'infrastructure', type: 'proxmox_api', path: 'sdwan', independenceGroup: 'proxmox', config: { proxmoxInstanceId: pA.id } });
    await check({ name: 'Site A TCP 8006', siteId: this.siteA.id, category: 'network', type: 'tcp', path: 'sdwan', independenceGroup: 'tcp', config: { host: '127.0.0.1', port: port(this.pveA.url) } });
    await check({ name: 'Site A ICMP', siteId: this.siteA.id, category: 'network', type: 'icmp', path: 'sdwan', independenceGroup: 'icmp', config: { host: '127.0.0.1' } });
    await check({ name: 'Tunnel A', siteId: this.siteA.id, category: 'tunnel', type: 'tunnel', path: 'cloudflare_api', independenceGroup: 'tunnel', config: { tunnelRef: tA.id } });
    // Site B (secondary)
    await check({ name: 'Proxmox B API', siteId: this.siteB.id, category: 'infrastructure', type: 'proxmox_api', path: 'local', independenceGroup: 'proxmox', config: { proxmoxInstanceId: pB.id } });
    await check({ name: 'Proxmox B node', siteId: this.siteB.id, category: 'infrastructure', type: 'proxmox_node', path: 'local', independenceGroup: 'proxmox-node', config: { proxmoxInstanceId: pB.id, node: 'pve-b' } });
    await check({ name: 'Tunnel B', siteId: this.siteB.id, category: 'tunnel', type: 'tunnel', path: 'cloudflare_api', independenceGroup: 'tunnel', config: { tunnelRef: tB.id } });
    await check({ name: 'NPM B API', siteId: this.siteB.id, category: 'infrastructure', type: 'npm_api', path: 'local', independenceGroup: 'npm', config: { npmInstanceId: nB.id } });

    let prio = 1;
    for (const spec of this.specs) {
      this.pveA.guests.push({ vmid: spec.vmA, name: `${spec.slug}-a`, status: 'running', kind: 'qemu' });
      this.pveB.guests.push({ vmid: spec.vmB, name: `${spec.slug}-b`, status: secondaryRunning ? 'running' : 'stopped', kind: 'qemu' });
      this.pveB.backups.push({ storage: 'pbs', vmid: spec.vmA, ctime: now - 7 * 60, volid: `pbs:backup/vm/${spec.vmA}` });
      this.appA.set(`/${spec.slug}${spec.path}`, { status: 200, body: `<html>${spec.marker}</html>` });
      this.appB.set(`/${spec.slug}${spec.path}`, { status: 200, body: `<html>${spec.marker}</html>` });
      this.cf.addRecord({ name: spec.host, type: 'CNAME', content: tunnelCname(TUN_A), ttl: 1, proxied: true });
      const hA = this.npmA.addHost({ domain_names: [spec.host], forward_scheme: 'http', forward_host: `10.1.0.${spec.vmA}`, forward_port: 80 });
      const hB = this.npmB.addHost({ domain_names: [spec.host], forward_scheme: 'http', forward_host: `10.2.0.${spec.vmB}`, forward_port: 80 });

      const app = await repos.applications.create({ slug: spec.slug, name: spec.name, failoverPriority: prio++, maxReplicationAgeSeconds: 900, activeSiteId: this.siteA.id });
      this.apps.push(app);
      await repos.workloads.create({ applicationId: app.id, siteId: this.siteA.id, proxmoxInstanceId: pA.id, node: 'pve-a', vmid: spec.vmA, kind: 'qemu', expectedName: `${spec.slug}-a`, standbyState: 'running' });
      await repos.workloads.create({
        applicationId: app.id,
        siteId: this.siteB.id,
        proxmoxInstanceId: pB.id,
        node: 'pve-b',
        vmid: spec.vmB,
        kind: 'qemu',
        expectedName: `${spec.slug}-b`,
        standbyState: secondaryRunning ? 'running' : 'stopped',
        allowStart: true,
        replicationSource: 'pve_backup',
        replicationVmid: spec.vmA,
        backupStorage: 'pbs',
      });
      const live = this.cf.record(spec.host)!;
      await repos.dnsRecords.create({ applicationId: app.id, zoneId: zone.id, recordId: live.id, name: spec.host, type: 'CNAME', primaryContent: tunnelCname(TUN_A), secondaryContent: tunnelCname(TUN_B), ttl: 1, proxied: true });
      await repos.npmExpectations.create({ applicationId: app.id, siteId: this.siteA.id, npmInstanceId: nA.id, proxyHostId: hA.id, domainNames: [spec.host], forwardScheme: 'http', forwardHost: `10.1.0.${spec.vmA}`, forwardPort: 80 });
      const expB = await repos.npmExpectations.create({ applicationId: app.id, siteId: this.siteB.id, npmInstanceId: nB.id, proxyHostId: hB.id, domainNames: [spec.host], forwardScheme: 'http', forwardHost: `10.2.0.${spec.vmB}`, forwardPort: 80 });

      // Application checks: through each site's NPM (validation hostname), with content assertions.
      await check({ name: `${spec.name} A`, siteId: this.siteA.id, applicationId: app.id, category: 'application', type: 'http', path: 'sdwan', independenceGroup: 'app-http', config: { url: `${this.appA.url}/${spec.slug}${spec.path}`, bodyContains: [spec.marker] } });
      await check({ name: `${spec.name} B`, siteId: this.siteB.id, applicationId: app.id, category: 'application', type: 'http', path: 'local', independenceGroup: 'app-http', config: { url: `${this.appB.url}/${spec.slug}${spec.path}`, bodyContains: [spec.marker], header: { name: 'x-served-by', equals: 'site-b' } } });
      await check({ name: `${spec.name} replication`, siteId: this.siteB.id, applicationId: app.id, category: 'replication', type: 'replication', path: 'local', independenceGroup: 'replication', config: {} });
      await check({ name: `${spec.name} NPM B`, siteId: this.siteB.id, applicationId: app.id, category: 'infrastructure', type: 'npm_proxy_host', path: 'local', independenceGroup: 'npm-host', config: { expectationId: expB.id } });
      // Public traffic checks through the Cloudflare edge, proving which site answered.
      for (const [site, marker] of [[this.siteA, 'site-a'], [this.siteB, 'site-b']] as const) {
        await check({ name: `${spec.name} public via ${site.code}`, siteId: site.id, applicationId: app.id, category: 'traffic', type: 'http', path: 'internet', independenceGroup: 'public-https', config: { url: `${this.edge.url}/`, hostHeader: spec.host, bodyContains: [spec.marker], header: { name: 'x-served-by', equals: marker } } });
      }
    }
    // Cold standby: Site B apps only answer when their VM runs.
    this.appB.upWhen = () => this.specs.every((s) => this.vmRunning(this.pveB, s.vmB));
  }

  /** Simulates total loss of Site A (power failure): hosts, NPM, apps and Tunnel A all gone. */
  async killSiteA() {
    this.siteAUp = false;
    await Promise.all([this.pveA.stop(), this.npmA.stop(), this.appA.stop()]);
    const t = this.cf.tunnels.get(TUN_A)!;
    t.status = 'down';
    t.connections = [];
  }

  /** Runs every check for both sites `rounds` times (deterministic stand-in for the scheduler). */
  async observe(rounds = 3) {
    for (let i = 0; i < rounds; i++) {
      await this.s.engine.runSite(this.siteA.id);
      await this.s.engine.runSite(this.siteB.id);
    }
  }

  get siteBName() {
    return this.siteB.name;
  }
}
