export type ProviderName = 'cloudflare' | 'proxmox' | 'npm';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly options: {
      status?: number;
      retryable?: boolean;
      kind?: 'auth' | 'not_found' | 'rate_limited' | 'server' | 'client' | 'network' | 'timeout' | 'tls' | 'blocked' | 'invalid_response';
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get status(): number | undefined {
    return this.options.status;
  }
  get kind(): string | undefined {
    return this.options.kind;
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export function kindForStatus(status: number): NonNullable<ProviderError['options']['kind']> {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}
