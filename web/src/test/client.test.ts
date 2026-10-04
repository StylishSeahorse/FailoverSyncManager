import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, qs, setCsrfToken, setUnauthenticatedHandler } from '../api/client';

describe('api client', () => {
  it('sends the CSRF token on writes only', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    setCsrfToken('tok');
    await api('GET', '/api/x');
    await api('POST', '/api/x', {});
    const headers = (f.mock.calls as unknown as Array<[string, RequestInit]>).map((c) => c[1].headers as Record<string, string>);
    expect(headers[0]!['x-csrf-token']).toBeUndefined();
    expect(headers[1]!['x-csrf-token']).toBe('tok');
    setCsrfToken(null);
  });

  it('turns API errors into ApiError with details and signals 401s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'precondition_failed', message: 'blocked', details: { blockers: [1] } }), { status: 422 })));
    await expect(api('POST', '/api/failover/execute', {})).rejects.toMatchObject({ status: 422, code: 'precondition_failed', message: 'blocked', details: { blockers: [1] } });
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthenticated', message: 'Login required' }), { status: 401 })));
    await expect(api('GET', '/api/system/status')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauth).toHaveBeenCalledOnce();
    setUnauthenticatedHandler(null);
  });

  it('builds query strings without empty values', () => {
    expect(qs({ a: 'x', b: '', c: undefined, d: 3 })).toBe('?a=x&d=3');
    expect(qs({})).toBe('');
  });
});
