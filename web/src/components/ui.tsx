import { useState, type ReactNode } from 'react';
import { errorText } from '../api/client';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'unknown';

/** Maps any status word the API uses to a colour tone. */
export function toneOf(status: string | null | undefined): Tone {
  switch ((status ?? '').toUpperCase()) {
    case 'OK':
    case 'PASS':
    case 'HEALTHY':
    case 'SAFE':
    case 'SUCCESS':
    case 'SUCCEEDED':
    case 'CONNECTED':
    case 'PRIMARY':
    case 'ACTIVE':
    case 'HEALTHY_PRIMARY':
    case 'SECONDARY_ACTIVE':
    case 'READY FOR FAILOVER':
    case 'FAILOVER READY':
      return 'ok';
    case 'WARNING':
    case 'DEGRADED':
    case 'READY WITH WARNINGS':
    case 'FAILOVER READY WITH WARNINGS':
    case 'DEGRADED_PRIMARY':
    case 'PRIMARY_FAILURE_DETECTED':
    case 'CONFIRMING_PRIMARY_FAILURE':
    case 'RECOVERY':
    case 'MAINTENANCE':
    case 'CANCELLED':
    case 'SKIPPED':
      return 'warn';
    case 'FAIL':
    case 'FAILED':
    case 'ERROR':
    case 'CRITICAL':
    case 'UNSAFE':
    case 'NOT READY':
    case 'FAILOVER NOT SAFE':
    case 'FAILOVER_FAILED':
    case 'PRIMARY_FAILURE_CONFIRMED':
      return 'bad';
    case 'RUNNING':
    case 'PLANNED':
    case 'INFO':
    case 'SECONDARY':
    case 'PROMOTING':
    case 'FAILOVER_IN_PROGRESS':
    case 'FAILOVER_PENDING':
      return 'info';
    default:
      return 'unknown';
  }
}

export function Badge({ status, label }: { status: string | null | undefined; label?: string }) {
  return <span className={`badge ${toneOf(status)}`}>{label ?? (status ?? 'UNKNOWN').replace(/_/g, ' ')}</span>;
}

const MARKS: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✗', info: '•', unknown: '?' };

export function Mark({ status }: { status: string }) {
  const t = toneOf(status);
  return (
    <span className={`mark ${t}`} aria-label={status}>
      {MARKS[t]}
    </span>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {errorText(error)}
    </div>
  );
}

export function Panel({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="row between" style={{ marginBottom: 12 }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** Runs an async action with busy/error/result state, for buttons. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<R | null>(null);
  const run = async (...args: A) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(...args);
      setResult(r);
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, result, reset: () => (setError(null), setResult(null)) };
}

export function Dialog({ title, danger, onClose, children }: { title: string; danger?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${danger ? ' danger' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Confirmation for operational actions. The user must type the phrase
 * exactly (case sensitive) before the confirm button enables.
 */
export function ConfirmDialog(props: {
  title: string;
  body: ReactNode;
  phrase?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const act = useAction(async () => {
    await props.onConfirm();
    return true;
  });
  const ok = !props.phrase || typed === props.phrase;
  return (
    <Dialog title={props.title} danger={props.danger} onClose={props.onClose}>
      <div className="stack">
        <div>{props.body}</div>
        {props.phrase && (
          <label>
            Type <code>{props.phrase}</code> to confirm
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="Confirmation phrase" />
          </label>
        )}
        <ErrorBox error={act.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={props.onClose}>Close</button>
          <button
            className={props.danger ? 'danger' : 'primary'}
            disabled={!ok || act.busy}
            onClick={async () => {
              const r = await act.run();
              if (r) props.onClose();
            }}
          >
            {act.busy ? 'Working…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
