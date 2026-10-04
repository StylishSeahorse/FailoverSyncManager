import { describe, expect, it } from 'vitest';
import { evaluate, initialState, type EvaluatorState, type Thresholds } from '../../src/health/evaluator.js';

const T: Thresholds = { consecutiveFailures: 5, minimumFailureDurationSeconds: 60, recoveryConsecutiveSuccesses: 5 };
const t0 = Date.parse('2026-10-04T15:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000);

function run(seq: Array<[boolean, number]>, start: EvaluatorState = initialState()) {
  let s = start;
  const statuses: string[] = [];
  for (const [ok, sec] of seq) {
    s = evaluate(s, { ok, message: ok ? 'ok' : 'fail', at: at(sec) }, T);
    statuses.push(s.status);
  }
  return { s, statuses };
}

describe('threshold evaluator', () => {
  it('goes OK on first success', () => {
    expect(run([[true, 0]]).statuses).toEqual(['OK']);
  });

  it('treats a single dropped packet as WARNING and clears on next success', () => {
    expect(run([[true, 0], [false, 10], [true, 20]]).statuses).toEqual(['OK', 'WARNING', 'OK']);
  });

  it('reaches DEGRADED at N failures inside the minimum duration', () => {
    const { statuses } = run([[false, 0], [false, 10], [false, 20], [false, 30], [false, 40]]);
    expect(statuses).toEqual(['WARNING', 'WARNING', 'WARNING', 'WARNING', 'DEGRADED']);
  });

  it('reaches FAILED only after N failures AND the minimum duration', () => {
    const { statuses, s } = run([[false, 0], [false, 15], [false, 30], [false, 45], [false, 59], [false, 60]]);
    expect(statuses.slice(-2)).toEqual(['DEGRADED', 'FAILED']);
    expect(s.firstFailureAt).toEqual(at(0));
  });

  it('does not fail on a long but sparse failure (fewer than N consecutive)', () => {
    const seq: Array<[boolean, number]> = [];
    for (let i = 0; i < 20; i++) seq.push([i % 4 !== 3, i * 15]); // fails 3 of 4
    // pattern ok,ok,ok,fail → never 5 consecutive failures
    expect(run(seq).statuses).not.toContain('FAILED');
    expect(run(seq).statuses).not.toContain('DEGRADED');
  });

  it('a brief outage (VM reboot under a minute) never reaches FAILED', () => {
    const seq: Array<[boolean, number]> = [[true, 0]];
    for (let i = 1; i <= 5; i++) seq.push([false, i * 10]); // 10..50s
    seq.push([true, 60]);
    expect(run(seq).statuses).not.toContain('FAILED');
  });

  it('requires M consecutive successes to recover from FAILED', () => {
    const fail: Array<[boolean, number]> = [0, 15, 30, 45, 60].map((s) => [false, s]);
    const { s: failed } = run(fail);
    expect(failed.status).toBe('FAILED');
    const { statuses } = run([[true, 70], [true, 80], [true, 90], [true, 100], [true, 110]], failed);
    expect(statuses).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'OK']);
  });

  it('a flapping check stays FAILED instead of bouncing', () => {
    const fail: Array<[boolean, number]> = [0, 15, 30, 45, 60].map((s) => [false, s]);
    const { s: failed } = run(fail);
    const { statuses, s } = run([[true, 70], [true, 80], [false, 90], [true, 100]], failed);
    expect(statuses).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
    expect(s.firstFailureAt).toEqual(at(0));
  });

  it('a DEGRADED check that fails again during recovery stays failing', () => {
    const { s: degraded } = run([[false, 0], [false, 5], [false, 10], [false, 15], [false, 20]]);
    expect(degraded.status).toBe('DEGRADED');
    const { statuses } = run([[true, 25], [false, 30]], degraded);
    expect(statuses).toEqual(['DEGRADED', 'DEGRADED']);
  });

  it('records latency and message', () => {
    const s = evaluate(initialState(), { ok: true, message: 'HTTP 200 in 12 ms', latencyMs: 12, at: at(0) }, T);
    expect(s.lastLatencyMs).toBe(12);
    expect(s.lastMessage).toBe('HTTP 200 in 12 ms');
    expect(s.lastSuccessAt).toEqual(at(0));
  });
});
