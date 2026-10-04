import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../api/client';
import { useInvalidate } from '../api/hooks';
import type { CloudflareAccount, NpmInstance, Operation, ProxmoxInstance, SystemStatus } from '../api/types';
import { useAuth } from '../auth';
import { FailoverDialog } from './FailoverDialog';
import { ConfirmDialog, Dialog, ErrorBox, JsonView, Mark, Panel, useAction } from './ui';

type Open = null | 'test' | 'failover' | 'cancel' | 'reconcile' | 'pause' | 'resume' | 'validate';

interface ValidationRow {
  label: string;
  ok: boolean;
  detail: unknown;
}

/** Runs every site and integration validation and lists the outcome of each. */
function ValidateAll({ status, onClose }: { status: SystemStatus; onClose: () => void }) {
  const act = useAction(async () => {
    const rows: ValidationRow[] = [];
    const attempt = async (label: string, fn: () => Promise<{ ok?: boolean; results?: Array<{ ok: boolean }> } & Record<string, unknown>>) => {
      try {
        const r = await fn();
        const ok = r.ok ?? (Array.isArray(r.results) ? r.results.every((x) => x.ok) : true);
        rows.push({ label, ok, detail: r });
      } catch (e) {
        rows.push({ label, ok: false, detail: { error: (e as Error).message } });
      }
    };
    const [pve, npm, cf] = await Promise.all([get<ProxmoxInstance[]>('/api/proxmox-instances'), get<NpmInstance[]>('/api/npm-instances'), get<CloudflareAccount[]>('/api/cloudflare-accounts')]);
    const siteName = (id: string) => status.sites.find((s) => s.id === id)?.name ?? 'site';
    await Promise.all([
      ...status.sites.map((s) => attempt(`Site ${s.name}: all health checks`, () => post(`/api/sites/${s.id}/validate`))),
      ...pve.map((p) => attempt(`Proxmox ${p.name} (${siteName(p.siteId)})`, () => post(`/api/proxmox-instances/${p.id}/validate`))),
      ...npm.map((n) => attempt(`NPM ${n.name} (${siteName(n.siteId)})`, () => post(`/api/npm-instances/${n.id}/validate`))),
      ...cf.map((c) => attempt(`Cloudflare ${c.name}`, () => post(`/api/cloudflare-accounts/${c.id}/validate`))),
    ]);
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Dialog title="Validate sites and integrations" onClose={onClose}>
      <div className="stack">
        <p className="muted">Runs every health check now and contacts each Proxmox, NPM and Cloudflare integration read-only. Nothing is changed.</p>
        <div>
          <button className="primary" disabled={act.busy} onClick={() => void act.run()}>
            {act.busy ? 'Validating…' : act.result ? 'Run again' : 'Run validation'}
          </button>
        </div>
        <ErrorBox error={act.error} />
        {act.result && (
          <ul className="items">
            {act.result.map((r) => (
              <li key={r.label}>
                <Mark status={r.ok ? 'PASS' : 'FAIL'} />
                <div>
                  <button className="ghost small" onClick={() => setExpanded(expanded === r.label ? null : r.label)}>
                    {r.label}
                  </button>
                  {expanded === r.label && <JsonView value={r.detail} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export function EmergencyControls({ status }: { status: SystemStatus }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<Open>(null);
  const ctl = status.controller;
  const target = status.sites.find((s) => s.id === status.readiness.targetSiteId) ?? status.sites.find((s) => !s.active);
  const running = !!ctl.currentOperationId;
  const operator = can('operator');
  const close = () => {
    setOpen(null);
    void invalidate('status', 'operations');
  };
  const goOp = (op: Operation) => {
    close();
    navigate(`/operations/${op.id}`);
  };

  return (
    <Panel title="Emergency controls">
      {!operator && <p className="muted">You have read-only access.</p>}
      <div className="controls">
        <button className="primary" disabled={!operator || running || !target} onClick={() => setOpen('test')}>
          Test failover
        </button>
        <button className="danger" disabled={!operator || running || !target} onClick={() => setOpen('failover')}>
          Failover now…
        </button>
        <button className="warn" disabled={!operator || !running} onClick={() => setOpen('cancel')}>
          Cancel failover
        </button>
        <button disabled={!operator || running} onClick={() => setOpen('reconcile')}>
          Reconcile from DNS
        </button>
        {ctl.monitoringPaused ? (
          <button disabled={!operator} onClick={() => setOpen('resume')}>
            Resume monitoring
          </button>
        ) : (
          <button disabled={!operator} onClick={() => setOpen('pause')}>
            Pause monitoring
          </button>
        )}
        <button disabled={!operator} onClick={() => setOpen('validate')}>
          Validate sites and integrations
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Automatic failover is {ctl.automaticFailover ? 'ON' : 'OFF'}. Failback and maintenance mode arrive in later phases.
      </p>

      {open === 'test' && target && (
        <ConfirmDialog
          title={`Test failover to ${target.name}`}
          body={<p>Runs every failover step as a dry run against live systems, read-only. No DNS, NPM or VM changes are made; you get a step-by-step report of what would happen.</p>}
          confirmLabel="Start test"
          onConfirm={async () => goOp(await post<Operation>('/api/failover/test', { targetSiteId: target.id }))}
          onClose={close}
        />
      )}
      {open === 'failover' && target && <FailoverDialog targetSiteId={target.id} targetName={target.name} onClose={close} onStarted={goOp} />}
      {open === 'cancel' && (
        <ConfirmDialog
          title="Cancel the running failover"
          body={<p>Cancellation only takes effect before routing changes begin. Once DNS has started changing the operation runs to completion or fails, and you then use Reconcile.</p>}
          confirmLabel="Request cancel"
          danger
          onConfirm={() => post('/api/failover/cancel')}
          onClose={close}
        />
      )}
      {open === 'reconcile' && (
        <ConfirmDialog
          title="Reconcile controller state from DNS"
          body={<p>Reads the managed DNS records from Cloudflare and sets the controller's state to match where traffic actually goes. It changes no DNS. If records are mixed, it reports that and changes nothing.</p>}
          confirmLabel="Reconcile"
          onConfirm={() => post('/api/failover/reconcile')}
          onClose={close}
        />
      )}
      {open === 'pause' && (
        <ConfirmDialog
          title="Pause monitoring"
          body={<p>Health checks stop running and readiness information will go stale. Use this only during planned work, and resume afterwards.</p>}
          phrase="PAUSE"
          confirmLabel="Pause monitoring"
          danger
          onConfirm={() => post('/api/monitoring/pause')}
          onClose={close}
        />
      )}
      {open === 'resume' && (
        <ConfirmDialog title="Resume monitoring" body={<p>Health checks start again on their normal schedule.</p>} confirmLabel="Resume" onConfirm={() => post('/api/monitoring/resume')} onClose={close} />
      )}
      {open === 'validate' && <ValidateAll status={status} onClose={close} />}
    </Panel>
  );
}
