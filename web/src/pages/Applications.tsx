import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../api/client';
import { useInvalidate, useList } from '../api/hooks';
import type { Application, CloudflareZone, DnsRecord, NpmExpectation, NpmInstance, ProxmoxInstance } from '../api/types';
import { useAuth } from '../auth';
import { Crud } from '../components/Crud';
import { Badge, Dialog, ErrorBox, fmtAge, Panel, useAction } from '../components/ui';
import { useSiteOptions } from './Settings';

export function ApplicationsPage() {
  return (
    <div className="stack">
      <h1>Applications</h1>
      <p className="muted">Each application lists its VMs at both sites, the DNS records that move on failover, and the NPM proxy hosts that must be ready at the standby site.</p>
      <Crud<Application>
        title="Applications"
        queryKey="applications"
        listPath="/api/applications"
        createPath="/api/applications"
        columns={[
          { label: 'Name', render: (a) => <Link to={`/applications/${a.id}`}>{a.name}</Link> },
          { label: 'Slug', render: (a) => <code>{a.slug}</code> },
          { label: 'Priority', render: (a) => a.failoverPriority },
          { label: 'Max replication age', render: (a) => fmtAge(a.maxReplicationAgeSeconds) },
          { label: 'Enabled', render: (a) => (a.enabled ? 'Yes' : <span className="badge warn">disabled</span>) },
        ]}
        createFields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Nextcloud' },
          { name: 'slug', label: 'Slug', required: true, placeholder: 'nextcloud' },
          { name: 'description', label: 'Description' },
          { name: 'failoverPriority', label: 'Failover priority (lower goes first)', type: 'number', placeholder: '100' },
          { name: 'maxReplicationAgeSeconds', label: 'Maximum replication age (s)', type: 'number', placeholder: '900' },
          { name: 'enabled', label: 'Enabled', type: 'checkbox' },
        ]}
        editFields={[
          { name: 'name', label: 'Name' },
          { name: 'description', label: 'Description' },
          { name: 'failoverPriority', label: 'Failover priority', type: 'number' },
          { name: 'maxReplicationAgeSeconds', label: 'Maximum replication age (s)', type: 'number' },
          { name: 'enabled', label: 'Enabled', type: 'checkbox' },
        ]}
      />
    </div>
  );
}

/** Picks a live Cloudflare record so the controller stores its real id and content. */
function AddDnsRecord({ appId, onClose }: { appId: string; onClose: () => void }) {
  const zones = useList<CloudflareZone[]>('zones', '/api/cloudflare-zones');
  const [zoneId, setZoneId] = useState('');
  const records = useList<Array<{ id: string; name: string; type: string; content: string; proxied: boolean; ttl: number }>>('zone-records', zoneId ? `/api/cloudflare-zones/${zoneId}/records` : null);
  const [recordId, setRecordId] = useState('');
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const invalidate = useInvalidate();
  const save = useAction(async () => {
    await post(`/api/applications/${appId}/dns-records`, { zoneId, recordId, primaryContent: primary.trim(), secondaryContent: secondary.trim() });
    await invalidate('dns', 'status');
    onClose();
    return true;
  });
  const rec = records.data?.find((r) => r.id === recordId);
  return (
    <Dialog title="Add managed DNS record" onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <label>
            Zone
            <select value={zoneId} onChange={(e) => (setZoneId(e.target.value), setRecordId(''))}>
              <option value="">Choose…</option>
              {zones.data?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Record
            <select
              value={recordId}
              disabled={!records.data}
              onChange={(e) => {
                setRecordId(e.target.value);
                const r = records.data?.find((x) => x.id === e.target.value);
                if (r) setPrimary(r.content);
              }}
            >
              <option value="">Choose…</option>
              {records.data
                ?.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.type} {r.name} → {r.content}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Content when Site A serves (primary)
            <input value={primary} onChange={(e) => setPrimary(e.target.value)} placeholder="tunnel-a-uuid.cfargotunnel.com" />
          </label>
          <label>
            Content when Site B serves (secondary)
            <input value={secondary} onChange={(e) => setSecondary(e.target.value)} placeholder="tunnel-b-uuid.cfargotunnel.com" />
          </label>
        </div>
        {rec && (
          <p className="muted small">
            Live record: {rec.type} {rec.name} → {rec.content} (proxied {rec.proxied ? 'yes' : 'no'}). The controller refuses to save if the live content matches neither target.
          </p>
        )}
        <ErrorBox error={records.error ?? save.error} />
        <div className="row">
          <button className="primary" disabled={!zoneId || !recordId || !primary.trim() || !secondary.trim() || save.busy} onClick={() => void save.run()}>
            Save
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Dialog>
  );
}

export function ApplicationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const app = useList<Application[]>('applications', '/api/applications');
  const a = app.data?.find((x) => x.id === id);
  const { options, name } = useSiteOptions();
  const pve = useList<ProxmoxInstance[]>('proxmox', '/api/proxmox-instances');
  const npm = useList<NpmInstance[]>('npm', '/api/npm-instances');
  const zones = useList<CloudflareZone[]>('zones', '/api/cloudflare-zones');
  const [addingDns, setAddingDns] = useState(false);
  if (app.error) return <ErrorBox error={app.error} />;
  if (!a) return <p className="muted">Loading…</p>;
  const pveOptions = (pve.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${name(p.siteId)})` }));
  const npmOptions = (npm.data ?? []).map((n) => ({ value: n.id, label: `${n.name} (${name(n.siteId)})` }));
  const base = `/api/applications/${a.id}`;

  return (
    <div className="stack">
      <div className="topbar">
        <h1>{a.name}</h1>
        <Link to="/applications">All applications</Link>
      </div>
      <Crud<{ id: string } & Record<string, unknown>>
        title="Workloads"
        queryKey="workloads"
        listPath={`${base}/workloads`}
        createPath={`${base}/workloads`}
        columns={[
          { label: 'Site', render: (w) => name(w.siteId as string) },
          { label: 'VM', render: (w) => <code>{`${w.kind} ${w.vmid} on ${w.node}`}</code> },
          { label: 'Expected name', render: (w) => String(w.expectedName ?? '') },
          { label: 'Standby state', render: (w) => <Badge status={w.standbyState === 'running' ? 'OK' : 'INFO'} label={String(w.standbyState)} /> },
          { label: 'Start allowed', render: (w) => (w.allowStart ? 'Yes' : 'No') },
          { label: 'Replication', render: (w) => String(w.replicationSource ?? '') },
        ]}
        createFields={[
          { name: 'siteId', label: 'Site', type: 'select', required: true, options },
          { name: 'proxmoxInstanceId', label: 'Proxmox instance', type: 'select', required: true, options: pveOptions },
          { name: 'node', label: 'Node', required: true },
          { name: 'vmid', label: 'VMID', type: 'number', required: true },
          { name: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'qemu', label: 'VM (qemu)' }, { value: 'lxc', label: 'Container (lxc)' }] },
          { name: 'standbyState', label: 'Normal state at a standby site', type: 'select', required: true, options: [{ value: 'stopped', label: 'Stopped (cold standby)' }, { value: 'running', label: 'Running (warm standby)' }] },
          { name: 'allowStart', label: 'Controller may start this VM during failover', type: 'checkbox' },
          { name: 'replicationSource', label: 'Replication source', type: 'select', required: true, options: [{ value: 'pve_replication', label: 'Proxmox replication' }, { value: 'pve_backup', label: 'Proxmox backup' }, { value: 'none', label: 'None' }] },
          { name: 'replicationVmid', label: 'Source VMID (if different)', type: 'number' },
          { name: 'backupStorage', label: 'Backup storage (for backups)' },
          { name: 'startOrder', label: 'Start order', type: 'number' },
        ]}
        editFields={[
          { name: 'allowStart', label: 'Controller may start this VM during failover', type: 'checkbox' },
          { name: 'startOrder', label: 'Start order', type: 'number' },
          { name: 'backupStorage', label: 'Backup storage' },
        ]}
        invalidate={['applications']}
      />
      <Crud<DnsRecord>
        title="DNS records"
        queryKey="dns"
        listPath={`${base}/dns-records`}
        createPath={`${base}/dns-records`}
        extra={
          can('admin') && (
            <div style={{ marginBottom: 10 }}>
              <button className="small" onClick={() => setAddingDns(true)} disabled={!zones.data?.length} title={zones.data?.length ? '' : 'Discover zones first'}>
                Add from Cloudflare
              </button>
            </div>
          )
        }
        columns={[
          { label: 'Record', render: (r) => <code>{`${r.type} ${r.name}`}</code> },
          { label: 'Site A target', render: (r) => <code>{r.primaryContent}</code> },
          { label: 'Site B target', render: (r) => <code>{r.secondaryContent}</code> },
          { label: 'Proxied', render: (r) => (r.proxied ? 'Yes' : 'No') },
        ]}
        editFields={[
          { name: 'primaryContent', label: 'Site A target' },
          { name: 'secondaryContent', label: 'Site B target' },
        ]}
      />
      <Crud<NpmExpectation>
        title="NPM proxy hosts"
        queryKey="npm-exp"
        listPath={`${base}/npm-expectations`}
        createPath={`${base}/npm-expectations`}
        columns={[
          { label: 'Site', render: (e) => name(e.siteId) },
          { label: 'Host #', render: (e) => e.proxyHostId },
          { label: 'Domains', render: (e) => e.domainNames.join(', ') },
          { label: 'Upstream', render: (e) => <code>{`${e.forwardScheme}://${e.forwardHost}:${e.forwardPort}`}</code> },
          { label: 'Must be enabled', render: (e) => (e.mustBeEnabled ? 'Yes' : 'No') },
          { label: 'Auto-enable', render: (e) => (e.allowAutoEnable ? 'Yes' : 'No') },
        ]}
        createFields={[
          { name: 'siteId', label: 'Site', type: 'select', required: true, options },
          { name: 'npmInstanceId', label: 'NPM instance', type: 'select', required: true, options: npmOptions },
          { name: 'proxyHostId', label: 'Proxy host ID', type: 'number', required: true, help: 'From Discover hosts on the NPM instance' },
          { name: 'fromLive', label: 'Copy domains and upstream from the live host', type: 'checkbox' },
          { name: 'domainNames', label: 'Domains (comma separated)', type: 'list' },
          { name: 'forwardScheme', label: 'Scheme', type: 'select', options: [{ value: 'http', label: 'http' }, { value: 'https', label: 'https' }] },
          { name: 'forwardHost', label: 'Upstream host' },
          { name: 'forwardPort', label: 'Upstream port', type: 'number' },
          { name: 'requireSsl', label: 'Require SSL certificate', type: 'checkbox' },
          { name: 'mustBeEnabled', label: 'Must be enabled before failover', type: 'checkbox' },
          { name: 'allowAutoEnable', label: 'Controller may enable it during failover', type: 'checkbox' },
        ]}
        editFields={[
          { name: 'mustBeEnabled', label: 'Must be enabled before failover', type: 'checkbox' },
          { name: 'allowAutoEnable', label: 'Controller may enable it during failover', type: 'checkbox' },
        ]}
      />
      {addingDns && <AddDnsRecord appId={a.id} onClose={() => setAddingDns(false)} />}
      <Panel title="Health">
        <p className="muted">
          Application checks are managed on the <Link to="/health-checks">Health checks</Link> page; pick this application when adding them.
        </p>
      </Panel>
    </div>
  );
}
