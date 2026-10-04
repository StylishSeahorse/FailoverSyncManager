import { useEffect, useState } from 'react';
import { post } from '../api/client';
import type { Operation, PreflightReport } from '../api/types';
import { useAuth } from '../auth';
import { StepTimeline } from './StepTimeline';
import { Badge, Dialog, ErrorBox, fmtAge, useAction } from './ui';

/**
 * Failover Now. Always runs a live preflight first, shows every blocker,
 * and only enables the button once the exact phrase is typed and every
 * blocker is either resolved or (admin only) acknowledged with a reason.
 */
export function FailoverDialog({ targetSiteId, targetName, onClose, onStarted }: { targetSiteId: string; targetName: string; onClose: () => void; onStarted: (op: Operation) => void }) {
  const { can } = useAuth();
  const isAdmin = can('admin');
  const prepare = useAction(() => post<PreflightReport>('/api/failover/prepare', { targetSiteId }));
  const execute = useAction((body: unknown) => post<Operation>('/api/failover/execute', body));
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    void prepare.run();
    // Run the preflight once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = prepare.result;
  const hard = report?.blockers.filter((b) => !b.overridable) ?? [];
  const soft = report?.blockers.filter((b) => b.overridable) ?? [];
  const unacked = soft.filter((b) => !acks.has(b.key));
  const needsReason = acks.size > 0;
  const canGo = !!report && !hard.length && !unacked.length && typed === report.confirmationPhrase && (!needsReason || reason.trim().length >= 10) && !execute.busy;

  const toggle = (key: string) =>
    setAcks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog title={`Failover to ${targetName}`} danger onClose={onClose}>
      <div className="stack">
        <div className="notice">
          This moves production traffic to {targetName}. DNS changes are made for real and are <strong>not rolled back automatically</strong>. Failback is a separate, manual operation.
        </div>
        {prepare.busy && <p className="muted">Running live preflight checks against both sites…</p>}
        <ErrorBox error={prepare.error} />
        {report && (
          <>
            <div className="row between">
              <Badge status={report.verdict} />
              <span className="muted">Estimated maximum data loss: {fmtAge(report.estimatedMaxDataLossSeconds)}</span>
            </div>
            <StepTimeline steps={report.steps} />
            {hard.length > 0 && (
              <div className="error" role="alert">
                <strong>Failover is blocked.</strong> Fix these first; they cannot be overridden:
                <ul>
                  {hard.map((b) => (
                    <li key={b.key}>{b.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {soft.length > 0 && (
              <div className="panel">
                <h3>Blockers that need an administrator's acknowledgement</h3>
                {!isAdmin && <p className="muted">Only an administrator can acknowledge these.</p>}
                {soft.map((b) => (
                  <label className="check" key={b.key}>
                    <input type="checkbox" checked={acks.has(b.key)} disabled={!isAdmin} onChange={() => toggle(b.key)} />
                    <span>{b.message}</span>
                  </label>
                ))}
                {needsReason && (
                  <label style={{ marginTop: 10 }}>
                    Reason for override (recorded in the audit log, at least 10 characters)
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                  </label>
                )}
              </div>
            )}
            <label>
              Type <code>{report.confirmationPhrase}</code> to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation phrase" />
            </label>
          </>
        )}
        <ErrorBox error={execute.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Close</button>
          <button disabled={prepare.busy} onClick={() => void prepare.run()}>
            Re-run preflight
          </button>
          <button
            className="danger"
            disabled={!canGo}
            onClick={async () => {
              const op = await execute.run({ targetSiteId, confirm: typed, acknowledge: [...acks], reason: needsReason ? reason.trim() : undefined });
              if (op) onStarted(op);
            }}
          >
            {execute.busy ? 'Starting…' : 'Fail over now'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
