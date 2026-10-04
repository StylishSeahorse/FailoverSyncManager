import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { pendingMigrations } from '../db/migrate.js';
import type { ApiContext } from './context.js';
import { errorHandler, HttpProblem } from './errors.js';
import { applicationRoutes } from './routes/applications.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { failoverRoutes } from './routes/failover.js';
import { healthCheckRoutes } from './routes/healthChecks.js';
import { providerRoutes } from './routes/providers.js';
import { siteRoutes } from './routes/sites.js';
import { statusRoutes } from './routes/status.js';
import { userRoutes } from './routes/users.js';
import { ROLE_RANK, SESSION_COOKIE, SessionService } from './sessions.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(ctx: ApiContext, opts: { logger?: boolean | object; trustProxy?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorateRequest('user', null);
  app.setErrorHandler(errorHandler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: ctx.config.FSM_COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: 'FailoverSyncManager API', version: '0.1.0', description: 'Two-site HA/DR failover controller' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE }, csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' } } },
      security: [{ session: [], csrf: [] }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiHooks: {
      onRequest: async (req) => {
        if (ctx.config.NODE_ENV === 'production') {
          req.user = await ctx.sessions.validate(req.cookies[SESSION_COOKIE]);
          if (req.user?.role !== 'admin') throw new HttpProblem(403, 'forbidden', 'API documentation requires admin');
        }
      },
    },
  });

  // Authentication, CSRF and RBAC for every route that declares a role.
  app.addHook('onRequest', async (req) => {
    const role = req.routeOptions.config?.role;
    if (!role) return;
    req.user = await ctx.sessions.validate(req.cookies[SESSION_COOKIE]);
    if (!req.user) throw new HttpProblem(401, 'unauthenticated', 'Login required');
    if (MUTATING.has(req.method) && !SessionService.csrfMatches(req.user.csrfToken, req.headers['x-csrf-token'] as string | undefined)) {
      throw new HttpProblem(403, 'csrf', 'Missing or invalid CSRF token');
    }
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) throw new HttpProblem(403, 'forbidden', `Requires ${role} role`);
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      const pending = await pendingMigrations(ctx.s.db);
      if (pending.length) return reply.status(503).send({ status: 'migrations pending', pending });
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'database unavailable' });
    }
  });
  app.get('/api/openapi.json', { schema: { hide: true }, config: { role: ctx.config.NODE_ENV === 'production' ? 'admin' : 'viewer' } }, async () => app.swagger());

  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await userRoutes(api, ctx);
    await statusRoutes(api, ctx);
    await siteRoutes(api, ctx);
    await providerRoutes(api, ctx);
    await applicationRoutes(api, ctx);
    await healthCheckRoutes(api, ctx);
    await failoverRoutes(api, ctx);
    await eventRoutes(api, ctx);
  });

  return app;
}
