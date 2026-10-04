import { buildApp } from './api/app.js';
import { SessionService } from './api/sessions.js';
import { loadConfig } from './config.js';
import { createServices } from './container.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { redact } from './security/redact.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const applied = await migrate(db);

const services = createServices({ db, masterKey: Buffer.from(config.FSM_MASTER_KEY, 'base64'), egressAllowlist: config.egressAllowlist });
await services.initialise();

const sessions = new SessionService(db, config.FSM_SESSION_TTL_HOURS, config.FSM_SESSION_IDLE_MINUTES);
const app = await buildApp(
  { s: services, sessions, config },
  {
    trustProxy: config.FSM_TRUST_PROXY,
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', '*.password', '*.apiToken', '*.tokenSecret'], censor: '[REDACTED]' },
    },
  },
);

// Mirror audit events into the structured log (already redacted by the audit writer).
services.audit.onEvent((e) => app.log.info({ audit: { id: e.id, severity: e.severity, category: e.category, action: e.action } }, redact(e.message, services.secrets.knownValues())));

const boot = await sessions.bootstrapAdmin(config.FSM_INITIAL_ADMIN_USERNAME, config.FSM_INITIAL_ADMIN_PASSWORD);
if (boot === 'created') app.log.warn(`Initial administrator "${config.FSM_INITIAL_ADMIN_USERNAME}" created; remove FSM_INITIAL_ADMIN_PASSWORD from the environment`);
if (boot === 'missing') app.log.error('No users exist and FSM_INITIAL_ADMIN_USERNAME/FSM_INITIAL_ADMIN_PASSWORD are not set; nobody can log in');
if (applied.length) app.log.info(`Applied migrations: ${applied.join(', ')}`);

const ctl = await services.store.controller();
services.engine.setPaused(ctl.monitoringPaused);
if (config.FSM_ENGINE_ENABLED) await services.engine.start();
await services.audit.write({ severity: 'INFO', category: 'system', action: 'controller.started', message: `Controller started (state ${ctl.failoverState}${ctl.monitoringPaused ? ', monitoring paused' : ''})`, actor: { type: 'system', name: 'controller' } });

const housekeeping = setInterval(() => {
  void services.healthState.prune(config.FSM_RESULT_RETENTION_DAYS).catch(() => undefined);
  void sessions.purgeExpired().catch(() => undefined);
}, 3600_000);
housekeeping.unref();

await app.listen({ host: config.FSM_LISTEN_HOST, port: config.FSM_PORT });

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig} received, shutting down`);
    services.engine.stop();
    await app.close();
    // A running failover is allowed to finish: abandoning one midway is worse than a slow shutdown.
    await services.close();
    await db.end();
    process.exit(0);
  });
}
