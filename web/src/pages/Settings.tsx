import { useState } from 'react';
import { get, post, put } from '../api/client';
import { useInvalidate, useList } from '../api/hooks';
import type { CloudflareAccount, CloudflareZone, HealthCheck, NpmInstance, Policy, ProxmoxInstance, Site, Tunnel, UserView, Application } from '../api/types';
import { useAuth } from '../auth';
import { Crud } from '../components/Crud';
import { SimpleForm, type Field } from '../components/Form';
import { Badge, Dialog, ErrorBox, fmtTime, JsonView, Panel } from '../components/ui';

export function useSiteOptions() {
  const sites = useList<Site[]>('sites', '/api/sites');
  const options = (sites.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }));
  const name = (id: string | null | undefined) => sites.data?.find((s) => s.id === id)?.name ?? '—';
  return { sites: sites.data ?? [], options, name };
}

const tlsFields: Field[] = [
  { name: 'tlsCaPem', label: 'CA certificate (PEM) for a self-signed endpoint', type: 'textarea', help: 'Preferred over disabling verification.' },
  { name: 'tlsInsecure', label: 'Skip TLS verification (not recommended, audited)', type: 'checkbox' },
];

export function SitesPage() {
  return (
    <div className="stack">
      <h1>Sites</h1>
      <p className="muted">Exactly two sites: one designated primary and one secondary. The designated role does not change on failover; the controller tracks which site is serving production separately.</p>
      <Crud<Site>
        title="Sites"
        queryKey="sites"
        listPath="/api/sites"
        createPath="/api/sites"
        columns={[
          { label: 'Name', render: (s) => <strong>{s.name}</strong> },
          { label: 'Code', render: (s) => <code>{s.code}</code> },
          { label: 'Designated role', render: (s) => s.designatedRole },
          { label: 'State', render: (s) => <Badge status={s.state} /> },
          { label: 'Serving', render: (s) => (s.active ? 'Yes' : '') },
          { label: 'Controller here', render: (s) => (s.hostsController ? 'Yes' : '') },
        ]}
        createFields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Site A' },
          { name: 'code', label: 'Code', required: true, placeholder: 'A', help: 'Upper case letters and digits, up to 8' },
          { name: 'designatedRole', label: 'Designated role', type: 'select', required: true, options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] },
          { name: 'description', label: 'Description' },
          { name: 'hostsController', label: 'This controller runs at this site', type: 'checkbox' },
        ]}
        editFields={[
          { name: 'name', label: 'Name' },
          { name: 'description', label: 'Description' },
          { name: 'hostsController', label: 'This controller runs at this site', type: 'checkbox' },
        ]}
        actions={[{ label: 'Validate', run: (s) => post(`/api/sites/${s.id}/validate`) }]}
      />
    </div>
  );
}

function ProxmoxTab() {
  const { options, name } = useSiteOptions();
  return (
    <Crud<ProxmoxInstance>
      title="Proxmox instances"
      queryKey="proxmox"
      listPath="/api/proxmox-instances"
      createPath="/api/proxmox-instances"
      columns={[
        { label: 'Name', render: (p) => <strong>{p.name}</strong> },
        { label: 'Site', render: (p) => name(p.siteId) },
        { label: 'URL', render: (p) => <code>{p.baseUrl}</code> },
        { label: 'Token', render: (p) => <code>{p.tokenId}</code> },
        { label: 'Secret', render: (p) => (p.tokenSecretConfigured ? 'configured' : <span className="badge bad">missing</span>) },
        { label: 'TLS', render: (p) => (p.tlsInsecure ? <span className="badge warn">unverified</span> : p.tlsCaConfigured ? 'custom CA' : 'system CA') },
      ]}
      createFields={[
        { name: 'siteId', label: 'Site', type: 'select', required: true, options },
        { name: 'name', label: 'Name', required: true, placeholder: 'pve-a' },
        { name: 'baseUrl', label: 'API URL', required: true, placeholder: 'https://10.0.0.10:8006' },
        { name: 'tokenId', label: 'API token ID', required: true, placeholder: 'failover@pve!controller' },
        { name: 'tokenSecret', label: 'API token secret', type: 'password', required: true },
        ...tlsFields,
      ]}
      editFields={[
        { name: 'name', label: 'Name' },
        { name: 'baseUrl', label: 'API URL' },
        { name: 'tokenId', label: 'API token ID' },
        { name: 'tokenSecret', label: 'New token secret (leave blank to keep)', type: 'password' },
        ...tlsFields,
      ]}
      actions={[
        { label: 'Validate', run: (p) => post(`/api/proxmox-instances/${p.id}/validate`) },
        { label: 'Discover VMs', run: (p) => get(`/api/proxmox-instances/${p.id}/discover`) },
      ]}
    />
  );
}

function NpmTab() {
  const { options, name } = useSiteOptions();
  return (
    <Crud<NpmInstance>
      title="Nginx Proxy Manager instances"
      queryKey="npm"
      listPath="/api/npm-instances"
      createPath="/api/npm-instances"
      columns={[
        { label: 'Name', render: (n) => <strong>{n.name}</strong> },
        { label: 'Site', render: (n) => name(n.siteId) },
        { label: 'URL', render: (n) => <code>{n.baseUrl}</code> },
        { label: 'Identity', render: (n) => n.identity },
        { label: 'Password', render: (n) => (n.passwordConfigured ? 'configured' : <span className="badge bad">missing</span>) },
      ]}
      createFields={[
        { name: 'siteId', label: 'Site', type: 'select', required: true, options },
        { name: 'name', label: 'Name', required: true, placeholder: 'npm-a' },
        { name: 'baseUrl', label: 'Admin URL', required: true, placeholder: 'http://10.0.0.20:81' },
        { name: 'identity', label: 'User email', required: true },
        { name: 'password', label: 'Password', type: 'password', required: true },
        ...tlsFields,
      ]}
      editFields={[
        { name: 'name', label: 'Name' },
        { name: 'baseUrl', label: 'Admin URL' },
        { name: 'identity', label: 'User email' },
        { name: 'password', label: 'New password (leave blank to keep)', type: 'password' },
        ...tlsFields,
      ]}
      actions={[
        { label: 'Validate', run: (n) => post(`/api/npm-instances/${n.id}/validate`) },
        { label: 'Discover hosts', run: (n) => get(`/api/npm-instances/${n.id}/discover`) },
      ]}
    />
  );
}

function CloudflareTab() {
  const { options, name } = useSiteOptions();
  const accounts = useList<CloudflareAccount[]>('cloudflare', '/api/cloudflare-accounts');
  const acctOptions = (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }));
  return (
    <div className="stack">
      <Crud<CloudflareAccount>
        title="Cloudflare accounts"
        queryKey="cloudflare"
        listPath="/api/cloudflare-accounts"
        createPath="/api/cloudflare-accounts"
        invalidate={['zones']}
        columns={[
          { label: 'Name', render: (c) => <strong>{c.name}</strong> },
          { label: 'Account ID', render: (c) => <code>{c.accountId}</code> },
          { label: 'API token', render: (c) => (c.apiTokenConfigured ? 'configured' : <span className="badge bad">missing</span>) },
        ]}
        createFields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'accountId', label: 'Cloudflare account ID', required: true },
          { name: 'apiToken', label: 'API token', type: 'password', required: true, help: 'Zone:DNS:Edit on the managed zones, Account:Cloudflare Tunnel:Read' },
        ]}
        editFields={[
          { name: 'name', label: 'Name' },
          { name: 'apiToken', label: 'New API token (leave blank to keep)', type: 'password' },
        ]}
        actions={[
          { label: 'Validate', run: (c) => post(`/api/cloudflare-accounts/${c.id}/validate`) },
          { label: 'Discover zones', role: 'admin', run: (c) => post(`/api/cloudflare-accounts/${c.id}/discover-zones`) },
        ]}
      />
      <Crud<CloudflareZone>
        title="Zones"
        queryKey="zones"
        listPath="/api/cloudflare-zones"
        empty="No zones yet. Use Discover zones on an account."
        columns={[
          { label: 'Zone', render: (z) => <strong>{z.name}</strong> },
          { label: 'Zone ID', render: (z) => <code>{z.zoneId}</code> },
        ]}
        actions={[{ label: 'DNS records', role: 'admin', run: (z) => get(`/api/cloudflare-zones/${z.id}/records`) }]}
      />
      <Crud<Tunnel>
        title="Tunnels"
        queryKey="tunnels"
        listPath="/api/tunnels"
        createPath="/api/tunnels"
        columns={[
          { label: 'Name', render: (t) => <strong>{t.name}</strong> },
          { label: 'Site', render: (t) => name(t.siteId) },
          { label: 'Tunnel ID', render: (t) => <code>{t.tunnelId}</code> },
        ]}
        createFields={[
          { name: 'siteId', label: 'Site', type: 'select', required: true, options },
          { name: 'cloudflareAccountId', label: 'Cloudflare account', type: 'select', required: true, options: acctOptions },
          { name: 'tunnelId', label: 'Tunnel ID (UUID)', required: true },
        ]}
        actions={[{ label: 'Validate', run: (t) => post(`/api/tunnels/${t.id}/validate`) }]}
      />
    </div>
  );
}

export function IntegrationsPage() {
  const [tab, setTab] = useState<'proxmox' | 'npm' | 'cloudflare'>('proxmox');
  return (
    <div className="stack">
      <h1>Integrations</h1>
      <p className="muted">Credentials are encrypted at rest and never shown again after saving. Use least-privilege tokens; see the operator guide.</p>
      <div className="tabs" role="tablist">
        {(
          [
            ['proxmox', 'Proxmox'],
            ['npm', 'Nginx Proxy Manager'],
            ['cloudflare', 'Cloudflare'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'proxmox' && <ProxmoxTab />}
      {tab === 'npm' && <NpmTab />}
      {tab === 'cloudflare' && <CloudflareTab />}
    </div>
  );
}

const CHECK_TYPES = ['icmp', 'tcp', 'http', 'dns', 'proxmox_api', 'proxmox_node', 'proxmox_vm', 'tunnel', 'npm_api', 'npm_proxy_host', 'replication'];
const CATEGORIES = ['network', 'infrastructure', 'application', 'tunnel', 'traffic', 'replication'];
const PATHS = ['sdwan', 'internet', 'cloudflare_api', 'local'];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

function CheckResults({ check, onClose }: { check: HealthCheck; onClose: () => void }) {
  const results = useList<Array<{ checkedAt: string; ok: boolean; message: string; latencyMs: number | null }>>('results', `/api/health-checks/${check.id}/results?limit=50`);
  return (
    <Dialog title={`Recent results: ${check.name}`} onClose={onClose}>
      <ErrorBox error={results.error} />
      <table>
        <tbody>
          {results.data?.map((r, i) => (
            <tr key={`${r.checkedAt}-${i}`}>
              <td className="small">{fmtTime(r.checkedAt)}</td>
              <td>
                <Badge status={r.ok ? 'OK' : 'FAILED'} />
              </td>
              <td className="small">{r.latencyMs ?? ''} ms</td>
              <td className="small">{r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

export function HealthChecksPage() {
  const { options, name } = useSiteOptions();
  const apps = useList<Application[]>('applications', '/api/applications');
  const appOptions = (apps.data ?? []).map((a) => ({ value: a.id, label: a.name }));
  const appName = (id: string | null) => apps.data?.find((a) => a.id === id)?.name ?? '';
  const [viewing, setViewing] = useState<HealthCheck | null>(null);
  const common: Field[] = [
    { name: 'intervalSeconds', label: 'Interval (seconds)', type: 'number', placeholder: '30' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '5000' },
    { name: 'critical', label: 'Critical', type: 'checkbox' },
    { name: 'enabled', label: 'Enabled', type: 'checkbox' },
  ];
  return (
    <div className="stack">
      <h1>Health checks</h1>
      <p className="muted">
        A site is only treated as failed when checks in several independence groups fail, including at least one that does not travel over the SD-WAN. Each check's config depends on its type; see the operator guide for examples.
      </p>
      <Crud<HealthCheck>
        title="Health checks"
        queryKey="checks"
        listPath="/api/health-checks"
        createPath="/api/health-checks"
        columns={[
          { label: 'Name', render: (c) => <strong>{c.name}</strong> },
          { label: 'Site', render: (c) => name(c.siteId) },
          { label: 'App', render: (c) => appName(c.applicationId) },
          { label: 'Type', render: (c) => <code>{c.type}</code> },
          { label: 'Path / group', render: (c) => `${c.path} / ${c.independenceGroup}` },
          { label: 'Status', render: (c) => <Badge status={c.enabled ? (c.state?.status ?? 'UNKNOWN') : 'DISABLED'} /> },
          { label: 'Last result', render: (c) => <span className="small muted">{c.state?.lastMessage}</span> },
        ]}
        createFields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'siteId', label: 'Site', type: 'select', required: true, options },
          { name: 'applicationId', label: 'Application', type: 'select', options: appOptions },
          { name: 'type', label: 'Type', type: 'select', required: true, options: opts(CHECK_TYPES) },
          { name: 'category', label: 'Category', type: 'select', required: true, options: opts(CATEGORIES) },
          { name: 'path', label: 'Network path', type: 'select', options: opts(PATHS) },
          { name: 'independenceGroup', label: 'Independence group', required: true, placeholder: 'internet-probe' },
          { name: 'config', label: 'Config (JSON)', type: 'json', required: true, placeholder: '{ "url": "https://example.com/health", "expectStatus": [200] }' },
          ...common,
        ]}
        editFields={[{ name: 'name', label: 'Name' }, { name: 'independenceGroup', label: 'Independence group' }, { name: 'config', label: 'Config (JSON)', type: 'json' }, ...common]}
        actions={[
          { label: 'Run now', run: (c) => post(`/api/health-checks/${c.id}/run`) },
          { label: 'History', role: 'viewer', run: async (c) => (setViewing(c), undefined) },
        ]}
      />
      {viewing && <CheckResults check={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

export function PolicyPage() {
  const policy = useList<Policy>('policy', '/api/policies/active');
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const [saved, setSaved] = useState(false);
  const fields: Field[] = [
    { name: 'consecutiveFailures', label: 'Consecutive failures before FAILED', type: 'number' },
    { name: 'minimumFailureDurationSeconds', label: 'Minimum failure duration (s)', type: 'number' },
    { name: 'recoveryConsecutiveSuccesses', label: 'Successes needed to recover', type: 'number' },
    { name: 'requiredFailedGroups', label: 'Independent groups that must fail', type: 'number' },
    { name: 'requireNonSdwanFailure', label: 'Require a failure seen outside the SD-WAN', type: 'checkbox' },
    { name: 'minimumSecondaryHealth', label: 'Minimum standby health', type: 'select', required: true, options: opts(['HEALTHY', 'DEGRADED']) },
    { name: 'serviceWaitTimeoutSeconds', label: 'Wait for services (s)', type: 'number' },
    { name: 'propagationWaitSeconds', label: 'DNS propagation wait (s)', type: 'number' },
    { name: 'verifyTimeoutSeconds', label: 'Traffic verification timeout (s)', type: 'number' },
    { name: 'circuitBreakerMaxFailovers', label: 'Circuit breaker: max failovers', type: 'number' },
    { name: 'circuitBreakerWindowSeconds', label: 'Circuit breaker window (s)', type: 'number' },
  ];
  return (
    <div className="stack">
      <h1>Failover policy</h1>
      <Panel>
        <div className="notice" style={{ marginBottom: 12 }}>
          Automatic failover and automatic failback are off and cannot be enabled in this phase. Monitoring only detects and reports; a person starts every failover.
        </div>
        <ErrorBox error={policy.error} />
        {policy.data &&
          (can('admin') ? (
            <SimpleForm
              key={JSON.stringify(policy.data)}
              fields={fields}
              initial={policy.data as unknown as Record<string, unknown>}
              submitLabel="Save policy"
              onSubmit={async (v) => {
                setSaved(false);
                await put('/api/policies/active', v);
                await invalidate('policy', 'status');
                setSaved(true);
              }}
            />
          ) : (
            <JsonView value={policy.data} />
          ))}
        {saved && <div className="success" style={{ marginTop: 12 }}>Policy saved.</div>}
      </Panel>
    </div>
  );
}

export function UsersPage() {
  const roles = opts(['viewer', 'operator', 'admin']);
  return (
    <div className="stack">
      <h1>Users</h1>
      <p className="muted">Viewers see status. Operators can test, fail over, cancel, reconcile and pause monitoring. Administrators also manage configuration, users and safety overrides.</p>
      <Crud<UserView>
        title="Users"
        queryKey="users"
        listPath="/api/users"
        createPath="/api/users"
        columns={[
          { label: 'Username', render: (u) => <strong>{u.username}</strong> },
          { label: 'Role', render: (u) => u.role },
          { label: 'Status', render: (u) => (u.disabled ? <span className="badge bad">disabled</span> : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <span className="badge warn">locked</span> : 'active') },
          { label: 'Last login', render: (u) => <span className="small">{fmtTime(u.lastLoginAt)}</span> },
        ]}
        createFields={[
          { name: 'username', label: 'Username', required: true },
          { name: 'password', label: 'Password (12+ characters)', type: 'password', required: true },
          { name: 'role', label: 'Role', type: 'select', required: true, options: roles },
        ]}
        editFields={[
          { name: 'role', label: 'Role', type: 'select', required: true, options: roles },
          { name: 'disabled', label: 'Disabled', type: 'checkbox' },
          { name: 'password', label: 'New password (leave blank to keep)', type: 'password' },
        ]}
      />
    </div>
  );
}
