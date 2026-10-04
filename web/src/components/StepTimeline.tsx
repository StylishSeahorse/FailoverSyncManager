import type { OperationStep, PreflightReport } from '../api/types';
import { Badge, fmtTime, Mark } from './ui';

type Step = Pick<OperationStep, 'key' | 'name' | 'status' | 'message'> & Partial<Pick<OperationStep, 'startedAt' | 'finishedAt' | 'seq'>>;

export function StepTimeline({ steps }: { steps: Step[] | PreflightReport['steps'] }) {
  if (!steps.length) return <p className="muted">No steps recorded yet.</p>;
  return (
    <ol className="timeline" aria-label="Operation steps">
      {(steps as Step[]).map((s, i) => (
        <li key={`${s.key}-${s.seq ?? i}`}>
          <Mark status={s.status} />
          <div>
            <div className="row">
              <strong>{s.name}</strong>
              <Badge status={s.status} />
            </div>
            {s.message && <div className="muted small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.message}</div>}
          </div>
          <div className="muted small">{s.startedAt ? fmtTime(s.startedAt) : ''}</div>
        </li>
      ))}
    </ol>
  );
}
