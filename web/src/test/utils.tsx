import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '../auth';
import type { Role } from '../api/types';

type Handler = (method: string, path: string, body: unknown, headers: Record<string, string>) => { status?: number; body: unknown } | undefined;

/** Replaces fetch with a router of canned responses; records every call. */
export function mockApi(role: Role, handler: Handler = () => undefined) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers });
    if (path === '/api/auth/me') return json(200, { user: { id: 'u1', username: role, role }, csrfToken: 'csrf-123' });
    const r = handler(method, path, body, headers);
    if (!r) return json(404, { error: 'not_found', message: `No mock for ${method} ${path}` });
    return json(r.status ?? 200, r.body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function renderWithApp(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
