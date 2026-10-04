import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Dashboard } from '../pages/Dashboard';
import { notSafeReadiness, status } from './fixtures';
import { mockApi, renderWithApp } from './utils';

describe('dashboard', () => {
  it('answers YES when failover is ready', async () => {
    mockApi('viewer', (_m, p) => (p === '/api/system/status' ? { body: status() } : undefined));
    renderWithApp(<Dashboard />);
    const banner = await screen.findByLabelText('Failover readiness');
    expect(within(banner).getByText('YES')).toBeInTheDocument();
    expect(within(banner).getByText(/If Site A disappeared right now/)).toBeInTheDocument();
    expect(within(banner).getByText(/Estimated maximum data loss: 4 min/)).toBeInTheDocument();
  });

  it('answers NO and puts the failing reason first', async () => {
    mockApi('viewer', (_m, p) => (p === '/api/system/status' ? { body: status({ readiness: notSafeReadiness }) } : undefined));
    renderWithApp(<Dashboard />);
    const banner = await screen.findByLabelText('Failover readiness');
    expect(within(banner).getByText('NO')).toBeInTheDocument();
    expect(within(banner).getByText('FAILOVER NOT SAFE')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/replication is 3.0 h old/)).toBeInTheDocument();
  });

  it('gives viewers read-only controls', async () => {
    mockApi('viewer', (_m, p) => (p === '/api/system/status' ? { body: status() } : undefined));
    renderWithApp(<Dashboard />);
    expect(await screen.findByRole('button', { name: 'Test failover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Failover now…' })).toBeDisabled();
    expect(screen.getByText('You have read-only access.')).toBeInTheDocument();
  });

  it('only enables cancel while an operation is running', async () => {
    mockApi('operator', (_m, p) => (p === '/api/system/status' ? { body: status() } : undefined));
    renderWithApp(<Dashboard />);
    expect(await screen.findByRole('button', { name: 'Cancel failover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test failover' })).toBeEnabled();
  });

  it('requires typing PAUSE before pausing monitoring, and sends the CSRF token', async () => {
    const calls = mockApi('operator', (m, p) => {
      if (p === '/api/system/status') return { body: status() };
      if (m === 'POST' && p === '/api/monitoring/pause') return { body: { monitoringPaused: true } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithApp(<Dashboard />);
    await user.click(await screen.findByRole('button', { name: 'Pause monitoring' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Pause monitoring' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'pause');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Confirmation phrase'));
    await user.type(within(dialog).getByLabelText('Confirmation phrase'), 'PAUSE');
    await user.click(confirm);
    const call = calls.find((c) => c.path === '/api/monitoring/pause');
    expect(call?.headers['x-csrf-token']).toBe('csrf-123');
  });
});
