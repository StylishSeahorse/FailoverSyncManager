import type { HttpClientLike } from '../http/client.js';
import type { Repos } from '../repos/index.js';
import type { SecretStore } from '../security/secretStore.js';
import { CloudflareProvider } from './cloudflare/CloudflareProvider.js';
import { NpmProvider } from './npm/NpmProvider.js';
import { ProxmoxProvider } from './proxmox/ProxmoxProvider.js';

export const SECRET_PURPOSE = {
  cloudflare: 'cloudflare.api_token',
  proxmox: 'proxmox.token_secret',
  npm: 'npm.password',
} as const;

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/**
 * Builds provider clients from stored configuration. Instances are cached per
 * row and rebuilt when the row's updated_at changes (credential rotation).
 */
export class ProviderRegistry {
  private cache = new Map<string, { stamp: number; provider: unknown }>();

  constructor(
    private readonly repos: Repos,
    private readonly secrets: SecretStore,
    private readonly http: HttpClientLike,
    private readonly opts: { timeoutMs?: number; retryDelayMs?: number } = {},
  ) {}

  private cached<T>(key: string, stamp: Date, build: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.stamp === stamp.getTime()) return Promise.resolve(hit.provider as T);
    return build().then((p) => {
      this.cache.set(key, { stamp: stamp.getTime(), provider: p });
      return p;
    });
  }

  invalidate(id?: string): void {
    if (!id) this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.endsWith(id)) this.cache.delete(k);
  }

  async cloudflare(accountRowId: string): Promise<{ provider: CloudflareProvider; accountId: string }> {
    const acct = await this.repos.cloudflareAccounts.get(accountRowId);
    if (!acct) throw new ProviderConfigError('Cloudflare account not found');
    if (!acct.apiTokenSecretId) throw new ProviderConfigError(`Cloudflare account "${acct.name}" has no API token configured`);
    const provider = await this.cached(`cf:${acct.id}`, acct.updatedAt, async () => {
      const token = await this.secrets.get(acct.apiTokenSecretId!, SECRET_PURPOSE.cloudflare);
      return new CloudflareProvider({ http: this.http, baseUrl: acct.baseUrl, ...this.opts }, token);
    });
    return { provider, accountId: acct.accountId };
  }

  async proxmox(instanceId: string): Promise<ProxmoxProvider> {
    const inst = await this.repos.proxmox.get(instanceId);
    if (!inst) throw new ProviderConfigError('Proxmox instance not found');
    if (!inst.tokenSecretId) throw new ProviderConfigError(`Proxmox "${inst.name}" has no API token secret configured`);
    return this.cached(`pve:${inst.id}`, inst.updatedAt, async () => {
      const secret = await this.secrets.get(inst.tokenSecretId!, SECRET_PURPOSE.proxmox);
      return new ProxmoxProvider(
        { http: this.http, baseUrl: inst.baseUrl, tls: { caPem: inst.tlsCaPem, insecure: inst.tlsInsecure }, ...this.opts },
        inst.tokenId,
        secret,
      );
    });
  }

  async npm(instanceId: string): Promise<NpmProvider> {
    const inst = await this.repos.npm.get(instanceId);
    if (!inst) throw new ProviderConfigError('NPM instance not found');
    if (!inst.secretId) throw new ProviderConfigError(`NPM "${inst.name}" has no password configured`);
    return this.cached(`npm:${inst.id}`, inst.updatedAt, async () => {
      const secret = await this.secrets.get(inst.secretId!, SECRET_PURPOSE.npm);
      return new NpmProvider(
        { http: this.http, baseUrl: inst.baseUrl, tls: { caPem: inst.tlsCaPem, insecure: inst.tlsInsecure }, ...this.opts },
        inst.identity,
        secret,
      );
    });
  }
}
