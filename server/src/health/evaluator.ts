import type { CheckStatus, HealthCheckState } from '../domain/types.js';

export interface Thresholds {
  consecutiveFailures: number;
  minimumFailureDurationSeconds: number;
  recoveryConsecutiveSuccesses: number;
}

export interface Observation {
  ok: boolean;
  message: string;
  latencyMs?: number | null;
  observed?: Record<string, unknown>;
  at: Date;
}

export type EvaluatorState = Omit<HealthCheckState, 'checkId'>;

export const initialState = (): EvaluatorState => ({
  status: 'UNKNOWN',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  firstFailureAt: null,
  lastSuccessAt: null,
  lastResultAt: null,
  lastLatencyMs: null,
  lastMessage: '',
  lastObserved: {},
});

/**
 * Per-check threshold evaluation. Pure.
 *
 *   OK ─fail→ WARNING (1..N-1 consecutive failures)
 *      ─≥N fails→ DEGRADED (failing, but for less than the minimum duration)
 *      ─≥N fails and failing ≥ T→ FAILED
 *
 * A single success clears WARNING (one dropped packet is noise). DEGRADED or
 * FAILED only clear after `recoveryConsecutiveSuccesses` successes in a row, so
 * a flapping service cannot bounce the site state.
 */
export function evaluate(prev: EvaluatorState, obs: Observation, t: Thresholds): EvaluatorState {
  const base = {
    lastResultAt: obs.at,
    lastLatencyMs: obs.latencyMs ?? null,
    lastMessage: obs.message,
    lastObserved: obs.observed ?? {},
  };

  if (obs.ok) {
    const successes = prev.consecutiveSuccesses + 1;
    const wasSerious = prev.status === 'DEGRADED' || prev.status === 'FAILED';
    let status: CheckStatus;
    if (!wasSerious) status = 'OK';
    else status = successes >= t.recoveryConsecutiveSuccesses ? 'OK' : prev.status;
    return {
      ...base,
      status,
      consecutiveSuccesses: successes,
      // Failure streak ends on any success, but a serious status keeps its
      // first-failure timestamp until it has actually recovered.
      consecutiveFailures: status === 'OK' ? 0 : prev.consecutiveFailures,
      firstFailureAt: status === 'OK' ? null : prev.firstFailureAt,
      lastSuccessAt: obs.at,
    };
  }

  // During recovery the failure streak was retained, so a new failure resumes
  // the existing episode instead of starting over at WARNING.
  const failures = prev.consecutiveFailures + 1;
  const firstFailureAt = prev.firstFailureAt ?? obs.at;
  const failingForS = (obs.at.getTime() - firstFailureAt.getTime()) / 1000;
  let status: CheckStatus;
  if (failures < t.consecutiveFailures) status = 'WARNING';
  else if (failingForS >= t.minimumFailureDurationSeconds) status = 'FAILED';
  else status = 'DEGRADED';
  if (prev.status === 'FAILED' && status !== 'FAILED') status = 'FAILED';
  return {
    ...base,
    status,
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    firstFailureAt,
    lastSuccessAt: prev.lastSuccessAt,
  };
}
