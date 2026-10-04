import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '../api/types';
import { FailoverDialog } from '../components/FailoverDialog';
import { preflight } from './fixtures';
import { mockApi, renderWithApp } from './utils';

function setup(role: Role, report = preflight()) {
  const calls = mockApi(role, (_m, p) => {
    if (p === '/api/failover/prepare') return { body: report };
    if (p === '/api/failover/execute') return { status: 202, body: { id: 'op1', status: 'running' } };
    return undefined;
  });
  const onStarted = vi.fn();
  renderWithApp(<FailoverDialog targetSiteId="b" targetName="Site B" onClose={() => {}} onStarted={onStarted} />);
  return { calls, onStarted, user: userEvent.setup() };
}

describe('failover dialog', () => {
  it('runs a live preflight and needs the exact phrase', async () => {
    const { calls, onStarted, user } = setup('operator');
    const go = screen.getByRole('button', { name: 'Fail over now' });
    await screen.findByText('READY FOR FAILOVER');
    expect(calls.some((c) => c.path === '/api/failover/prepare')).toBe(true);
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText('Confirmation phrase'), 'failover to site b');
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText('Confirmation phrase'));
    await user.type(screen.getByLabelText('Confirmation phrase'), 'FAILOVER TO SITE B');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(calls.find((c) => c.path === '/api/failover/execute')?.body).toEqual({ targetSiteId: 'b', confirm: 'FAILOVER TO SITE B', acknowledge: [] });
  });

  it('stays blocked by a hard blocker even with the phrase', async () => {
    const { user } = setup('admin', preflight({ verdict: 'NOT READY', blockers: [{ key: 'secondary.npm', message: 'NPM at Site B unreachable', overridable: false }] }));
    await screen.findByText(/NPM at Site B unreachable/);
    await user.type(screen.getByLabelText('Confirmation phrase'), 'FAILOVER TO SITE B');
    expect(screen.getByRole('button', { name: 'Fail over now' })).toBeDisabled();
  });

  it('lets only an admin acknowledge an overridable blocker, with a reason', async () => {
    const report = preflight({ verdict: 'NOT READY', blockers: [{ key: 'primary.reachable', message: 'Site A is still reachable', overridable: true }], overridable: ['primary.reachable'] });
    const { calls, user } = setup('admin', report);
    const box = await screen.findByRole('checkbox', { name: 'Site A is still reachable' });
    await user.type(screen.getByLabelText('Confirmation phrase'), 'FAILOVER TO SITE B');
    const go = screen.getByRole('button', { name: 'Fail over now' });
    expect(go).toBeDisabled();
    await user.click(box);
    expect(go).toBeDisabled(); // reason still missing
    await user.type(screen.getByRole('textbox', { name: /Reason for override/ }), 'Planned switchover for Site A power work');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === '/api/failover/execute')).toBeTruthy());
    expect(calls.find((c) => c.path === '/api/failover/execute')?.body).toMatchObject({ acknowledge: ['primary.reachable'], reason: 'Planned switchover for Site A power work' });
  });

  it('does not let an operator acknowledge overrides', async () => {
    setup('operator', preflight({ verdict: 'NOT READY', blockers: [{ key: 'primary.reachable', message: 'Site A is still reachable', overridable: true }] }));
    expect(await screen.findByRole('checkbox', { name: 'Site A is still reachable' })).toBeDisabled();
    expect(screen.getByText(/Only an administrator can acknowledge/)).toBeInTheDocument();
  });

  it('shows a server refusal', async () => {
    const calls = mockApi('operator', (_m, p) => {
      if (p === '/api/failover/prepare') return { body: preflight() };
      if (p === '/api/failover/execute') return { status: 422, body: { error: 'precondition_failed', message: 'Failover blocked: Site B replication too old' } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithApp(<FailoverDialog targetSiteId="b" targetName="Site B" onClose={() => {}} onStarted={() => {}} />);
    await screen.findByText('READY FOR FAILOVER');
    await user.type(screen.getByLabelText('Confirmation phrase'), 'FAILOVER TO SITE B');
    await user.click(screen.getByRole('button', { name: 'Fail over now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Site B replication too old');
    expect(calls.filter((c) => c.path === '/api/failover/execute')).toHaveLength(1);
  });
});
