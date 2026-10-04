import { Link, useParams } from 'react-router-dom';
import { useList } from '../api/hooks';
import type { AuditEvent, Operation, Site } from '../api/types';
import { StepTimeline } from '../components/StepTimeline';
import { Badge, ErrorBox, fmtAge, fmtTime, JsonView, Mark, Panel } from '../components/ui';

const kindLabel = (k: Operation['kind']) => (k === 'dry_run' ? 'Test failover' : k === 'failover' ? 'Failover' : k);

export function OperationsList() {
  const ops = useList<Operation[]>('operations', '/api/operations?limit=100', 5000);
  const sites = useList<Site[]>('sites', '/api/sites');
  const name = (id: string | null) => sites.data?.find((s) => s.id === id)?.name ?? '';
  return (
    <div className="stack">
      <h1>Operations</h1>
      <ErrorBox error={ops.error} />
      <Panel>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Kind</th>
                <th>Route</th>
                <th>Status</th>
                <th>Requested by</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {ops.data?.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/operations/${o.id}`}>{fmtTime(o.startedAt)}</Link>
                  </td>
                  <td>{kindLabel(o.kind)}</td>
                  <td>
                    {name(o.sourceSiteId)} → {name(o.targetSiteId)}
                  </td>
                  <td>
                    <Badge status={o.status} />
                  </td>
                  <td>{o.requestedByName}</td>
                  <td className="muted small">{o.verdict ?? o.error ?? ''}</td>
                </tr>
              ))}
              {ops.data && !ops.data.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No operations yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export function OperationDetail() {
  const { id } = useParams();
  const op = useList<Operation>('operation', `/api/operations/${id}`, 1500);
  const events = useList<AuditEvent[]>('events', `/api/events?operationId=${id}&limit=200`, op.data?.status === 'running' ? 2000 : undefined);
  const sites = useList<Site[]>('sites', '/api/sites');
  const name = (sid: string | null) => sites.data?.find((s) => s.id === sid)?.name ?? '';
  if (op.error) return <ErrorBox error={op.error} />;
  const o = op.data;
  if (!o) return <p className="muted">Loading…</p>;
  const duration = o.finishedAt ? (new Date(o.finishedAt).getTime() - new Date(o.startedAt).getTime()) / 1000 : null;
  return (
    <div className="stack">
      <div className="topbar">
        <h1>
          {kindLabel(o.kind)}: {name(o.sourceSiteId)} → {name(o.targetSiteId)}
        </h1>
        <Badge status={o.status} />
      </div>
      <Panel>
        <div className="form-grid">
          <div>
            <div className="muted small">Requested by</div>
            {o.requestedByName}
          </div>
          <div>
            <div className="muted small">Started</div>
            {fmtTime(o.startedAt)}
          </div>
          <div>
            <div className="muted small">Duration</div>
            {duration === null ? 'running' : fmtAge(duration)}
          </div>
          <div>
            <div className="muted small">Current stage</div>
            {o.currentStage ?? '—'}
          </div>
        </div>
        {o.verdict && <p style={{ marginTop: 12 }}><strong>{o.verdict}</strong></p>}
        {o.error && <div className="error" style={{ marginTop: 12 }}>Failed at {o.failedStage}: {o.error}</div>}
        {o.acknowledged.length > 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            Overrode {o.acknowledged.join(', ')}. Reason: {o.overrideReason}
          </div>
        )}
        {o.cancelRequested && o.status === 'running' && <div className="notice" style={{ marginTop: 12 }}>Cancel requested.</div>}
      </Panel>
      <div className="grid grid-2">
        <Panel title="Steps">
          <StepTimeline steps={o.steps ?? []} />
        </Panel>
        <Panel title="Audit trail">
          <ul className="items">
            {events.data?.map((e) => (
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
      {Object.keys(o.summary ?? {}).length > 0 && (
        <Panel title="Summary">
          <JsonView value={o.summary} />
        </Panel>
      )}
    </div>
  );
}
