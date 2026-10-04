import { Link } from 'react-router-dom';
import { useSystemStatus } from '../api/hooks';
import type { Dimension, Readiness, SiteView, SystemStatus } from '../api/types';
import { EmergencyControls } from '../components/EmergencyControls';
import { StepTimeline } from '../components/StepTimeline';
import { Badge, ErrorBox, fmtAge, fmtTime, Mark, Panel } from '../components/ui';

const GROUP_LABEL: Record<string, string> = {
  controller: 'Controller',
  site: 'Standby site',
  proxmox: 'Proxmox',
  workloads: 'Workloads',
  applications: 'Applications',
  replication: 'Replication',
  npm: 'Nginx Proxy Manager',
  tunnel: 'Cloudflare Tunnel',
  dns: 'DNS',
};

export function VerdictBanner({ readiness }: { readiness: Readiness }) {
  const tone = !readiness.ready ? 'no' : readiness.verdict === 'FAILOVER READY' ? 'yes' : 'warn';
  return (
    <section className={`verdict ${tone}`} aria-label="Failover readiness">
      <div className="answer">{readiness.ready ? 'YES' : 'NO'}</div>
      <div>
        <div className="q">{readiness.question}</div>
        <div className="v">{readiness.verdict}</div>
        <div className="muted small" style={{ marginTop: 6 }}>
          Estimated maximum data loss: {fmtAge(readiness.estimatedMaxDataLossSeconds)} · Based on monitoring at {fmtTime(readiness.evaluatedAt)}. Test Failover re-checks everything live.
        </div>
      </div>
    </section>
  );
}

function ReadinessList({ readiness }: { readiness: Readiness }) {
  const order = ['controller', 'site', 'proxmox', 'workloads', 'applications', 'replication', 'npm', 'tunnel', 'dns'];
  const sorted = [...readiness.items].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const failing = sorted.filter((i) => i.status !== 'PASS');
  return (
    <Panel title="Why">
      {failing.length > 0 && (
        <>
          <h3>Needs attention</h3>
          <ul className="items" style={{ marginBottom: 14 }}>
            {failing.map((i) => (
              <li key={i.key}>
                <Mark status={i.status} />
                <span>
                  <span className="muted">{GROUP_LABEL[i.group] ?? i.group}:</span> {i.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Passing</h3>
      <ul className="items">
        {sorted
          .filter((i) => i.status === 'PASS')
          .map((i) => (
            <li key={i.key}>
              <Mark status={i.status} />
              <span>{i.message}</span>
            </li>
          ))}
      </ul>
    </Panel>
  );
}

function Dim({ label, d }: { label: string; d: Dimension }) {
  return (
    <>
      <span className="muted">{label}</span>
      <span title={d.reasons.join('\n')}>
        <Badge status={d.status} /> {d.status !== 'HEALTHY' && d.reasons[0] && <span className="muted small">{d.reasons[0]}</span>}
      </span>
    </>
  );
}

function SiteTile({ site }: { site: SiteView }) {
  return (
    <section className={`panel site-tile${site.active ? ' active' : ''}`} aria-label={`Site ${site.name}`}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>
          {site.name} <span className="muted small">({site.code})</span>
        </h2>
        <div className="row">
          {site.active && <span className="badge info">SERVING PRODUCTION</span>}
          <Badge status={site.state} />
        </div>
      </div>
      {site.stateReason && <div className="muted small" style={{ marginTop: 4 }}>{site.stateReason}</div>}
      <div className="kv">
        <Dim label="Site health" d={site.health.site} />
        <Dim label="Proxmox" d={site.providers.proxmox} />
        <Dim label="NPM" d={site.providers.npm} />
        <Dim label="Tunnel" d={site.health.tunnel} />
        {site.active ? (
          <Dim label="Public traffic" d={site.health.traffic} />
        ) : (
          <>
            <span className="muted">Public traffic</span>
            <span className="muted small">Not serving; verified during failover</span>
          </>
        )}
        <span className="muted">Role</span>
        <span>
          Designated {site.designatedRole}
          {site.hostsController ? ' · hosts this controller' : ''}
        </span>
      </div>
    </section>
  );
}

function Applications({ status }: { status: SystemStatus }) {
  const sites = status.sites;
  return (
    <Panel title="Applications">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Application</th>
              {sites.map((s) => (
                <th key={s.id}>{s.name}</th>
              ))}
              <th>Replication age</th>
            </tr>
          </thead>
          <tbody>
            {status.applications.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  {!a.enabled && <span className="muted small"> (disabled)</span>}
                </td>
                {sites.map((s) => {
                  const d = a.perSite[s.id];
                  const cold = a.standbyMode === 'cold' && a.standbySiteId === s.id && d?.status !== 'HEALTHY';
                  return (
                    <td key={s.id} title={d?.reasons.join('\n')}>
                      {cold ? <Badge status="INFO" label="COLD STANDBY" /> : <Badge status={d?.status} />}
                      {a.activeSiteId === s.id && <span className="muted small"> serving</span>}
                    </td>
                  );
                })}
                <td title={a.replication.message}>
                  <Badge status={a.replication.safety} label={a.replication.ageSeconds === null ? 'UNKNOWN' : fmtAge(a.replication.ageSeconds)} />
                  <span className="muted small"> limit {fmtAge(a.replication.maxAgeSeconds)}</span>
                </td>
              </tr>
            ))}
            {!status.applications.length && (
              <tr>
                <td colSpan={sites.length + 2} className="muted">
                  No applications configured yet. <Link to="/applications">Add one</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Dashboard() {
  const { data: status, error, isLoading } = useSystemStatus();
  if (isLoading) return <p className="muted">Loading status…</p>;
  if (!status) return <ErrorBox error={error ?? new Error('No status')} />;
  const ctl = status.controller;
  const active = status.sites.find((s) => s.id === ctl.activeSiteId);
  const op = status.operation;
  return (
    <div className="stack">
      <div className="topbar">
        <h1>Failover status</h1>
        <div className="row">
          <span className="muted">Controller state</span>
          <Badge status={ctl.failoverState} />
          <span className="muted">Production on</span>
          <strong>{active?.name ?? 'unknown'}</strong>
          {ctl.monitoringPaused && <span className="badge warn">MONITORING PAUSED</span>}
          {ctl.circuitOpen && <span className="badge bad">CIRCUIT BREAKER OPEN</span>}
          {error && <span className="badge bad" title={String(error)}>STATUS STALE</span>}
        </div>
      </div>
      <VerdictBanner readiness={status.readiness} />
      {status.readiness.primary && status.readiness.primary.level !== 'HEALTHY' && (
        <div className="notice">
          {active?.name ?? 'Active site'}: {status.readiness.primary.level.replace(/_/g, ' ')}. {status.readiness.primary.reasons.join('; ')}
        </div>
      )}
      <div className="grid grid-2">
        <ReadinessList readiness={status.readiness} />
        <div className="stack">
          <EmergencyControls status={status} />
          <Panel title="Cloudflare">
            <div className="row">
              <Badge status={status.cloudflare.status} />
              <span className="muted">{status.cloudflare.message}</span>
            </div>
          </Panel>
        </div>
      </div>
      <div className="grid grid-2">
        {status.sites.map((s) => (
          <SiteTile key={s.id} site={s} />
        ))}
      </div>
      <Applications status={status} />
      <div className="grid grid-2">
        <Panel title={op ? (op.status === 'running' ? 'Running operation' : 'Last operation') : 'Operations'} actions={op && <Link to={`/operations/${op.id}`}>Details</Link>}>
          {op ? (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <Badge status={op.status} />
                <span>{op.kind === 'dry_run' ? 'Test failover' : op.kind}</span>
                <span className="muted small">
                  by {op.requestedByName} at {fmtTime(op.startedAt)}
                </span>
              </div>
              {op.verdict && <p>{op.verdict}</p>}
              <StepTimeline steps={op.steps ?? []} />
            </>
          ) : (
            <p className="muted">No failover or test has been run yet.</p>
          )}
        </Panel>
        <Panel title="Recent events" actions={<Link to="/events">All events</Link>}>
          <ul className="items">
            {status.recentEvents.slice(0, 15).map((e) => (
              <li key={e.id}>
                <Mark status={e.severity} />
                <span>
                  <span className="muted small">{fmtTime(e.at)}</span> {e.message}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
