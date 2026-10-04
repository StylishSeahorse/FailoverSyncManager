import { AuditLog } from './audit/audit.js';
import type { Db } from './db/pool.js';
import { HealthEngine } from './health/engine.js';
import { Monitor } from './health/monitor.js';
import { systemDns, systemPing } from './health/checks/executors.js';
import type { CheckDeps, DnsLookup, Pinger } from './health/checks/types.js';
import { HttpClient } from './http/client.js';
import { EgressGuard } from './http/egress.js';
import { FailoverOrchestrator } from './orchestrator/orchestrator.js';
import { ReadinessService } from './orchestrator/readiness.js';
import { ReplicationService } from './orchestrator/replication.js';
import { ProviderRegistry } from './providers/registry.js';
import { HealthStateRepo } from './repos/healthState.js';
import { createRepos } from './repos/index.js';
import { OperationsRepo } from './repos/operations.js';
import { PolicyRepo } from './repos/policy.js';
import { SecretBox } from './security/secretBox.js';
import { SecretStore } from './security/secretStore.js';
import { StateStore } from './state/store.js';

export interface ServiceOptions {
  db: Db;
  masterKey: Buffer;
  egressAllowlist: string[] | '*';
  ping?: Pinger;
  dns?: DnsLookup;
  now?: () => Date;
  providerTimeoutMs?: number;
  retryDelayMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  engineJitter?: number;
}

/** Composition root: wires every service once, for the server and for tests. */
export function createServices(o: ServiceOptions) {
  const repos = createRepos(o.db);
  const policies = new PolicyRepo(o.db);
  const operations = new OperationsRepo(o.db);
  const healthState = new HealthStateRepo(o.db);
  const secrets = new SecretStore(o.db, new SecretBox(o.masterKey));
  const audit = new AuditLog(o.db, () => secrets.knownValues());
  const egress = new EgressGuard(o.egressAllowlist);
  const http = new HttpClient(egress, o.providerTimeoutMs ?? 10_000);
  const providers = new ProviderRegistry(repos, secrets, http, { timeoutMs: o.providerTimeoutMs, retryDelayMs: o.retryDelayMs });
  const replication = new ReplicationService(repos, providers, o.now);
  const store = new StateStore(o.db, audit);
  const checkDeps: CheckDeps = { http, egress, providers, repos, replication, ping: o.ping ?? systemPing, dns: o.dns ?? systemDns };

  let activeSiteId: string | null = null;
  const refreshActiveSite = async () => {
    activeSiteId = (await store.controller().catch(() => null))?.activeSiteId ?? null;
  };

  // eslint-disable-next-line prefer-const
  let engine: HealthEngine;
  const monitor = new Monitor(repos, policies, store, audit, () => engine);
  engine = new HealthEngine(repos, healthState, policies, audit, checkDeps, {
    now: o.now,
    jitter: o.engineJitter,
    isActiveSite: (id) => activeSiteId === null || activeSiteId === id,
    onSiteEvaluated: async () => {
      await monitor.evaluate();
      await refreshActiveSite();
    },
  });
  const orchestrator = new FailoverOrchestrator(o.db, repos, policies, operations, store, audit, providers, engine, replication, checkDeps, {
    pollMs: o.pollMs,
    sleep: o.sleep,
  });
  const readiness = new ReadinessService(repos, store, engine, policies);

  return {
    db: o.db,
    repos,
    policies,
    operations,
    healthState,
    secrets,
    audit,
    egress,
    http,
    providers,
    replication,
    store,
    checkDeps,
    engine,
    monitor,
    orchestrator,
    readiness,
    refreshActiveSite,
    /** Startup tasks: initialise state rows, recover orphaned operations, warm redaction cache. */
    async initialise() {
      await secrets.warm();
      await policies.active();
      await store.ensureInitialised(await repos.sites.list());
      for (const op of await operations.failOrphans()) {
        await audit.write({
          severity: 'CRITICAL',
          category: 'failover',
          action: 'operation.orphaned',
          message: `Operation ${op.kind} was interrupted by a controller restart at stage "${op.failedStage ?? 'unknown'}". It was NOT resumed; review state and run Reconcile`,
          actor: { type: 'system', name: 'controller' },
          operationId: op.id,
        });
        const ctl = await store.controller();
        if (ctl.currentOperationId === op.id) {
          if (['CHECK_SECONDARY', 'SECONDARY_READY', 'PROMOTING_SECONDARY', 'UPDATING_ROUTING', 'VERIFYING_TRAFFIC'].includes(ctl.failoverState)) {
            await store.transitionFailover('STEP_FAILED', {
              actor: { type: 'system', name: 'controller' },
              reason: 'controller restarted during failover',
              operationId: op.id,
              set: { currentOperationId: null },
            });
          } else await store.clearOperation(op.id);
        }
      }
      await refreshActiveSite();
    },
    async close() {
      engine.stop();
      await orchestrator.waitAll();
      await http.close();
    },
  };
}

export type Services = ReturnType<typeof createServices>;
