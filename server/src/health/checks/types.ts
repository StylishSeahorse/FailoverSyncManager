import type { HealthCheck } from '../../domain/types.js';
import type { HttpClientLike } from '../../http/client.js';
import type { EgressGuard } from '../../http/egress.js';
import type { ReplicationService } from '../../orchestrator/replication.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { Repos } from '../../repos/index.js';

export interface CheckResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  observed?: Record<string, unknown>;
}

export type Pinger = (host: string, timeoutMs: number) => Promise<{ alive: boolean; timeMs?: number; error?: string }>;
export type DnsLookup = (name: string, type: 'A' | 'AAAA' | 'CNAME', server?: string) => Promise<string[]>;

export interface CheckDeps {
  http: HttpClientLike;
  egress: EgressGuard;
  providers: ProviderRegistry;
  repos: Repos;
  replication: ReplicationService;
  ping: Pinger;
  dns: DnsLookup;
}

export type CheckExecutor = (check: HealthCheck, deps: CheckDeps) => Promise<CheckResult>;
