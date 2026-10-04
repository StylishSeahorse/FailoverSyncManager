import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Services } from '../container.js';
import type { Actor, Role } from '../domain/types.js';
import { HttpProblem } from './errors.js';
import { ROLE_RANK, type SessionService, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    /** Minimum role for the route. Routes without it are public (login, health). */
    role?: Role;
  }
}

export interface ApiContext {
  s: Services;
  sessions: SessionService;
  config: Pick<AppConfig, 'FSM_COOKIE_SECURE' | 'FSM_SESSION_TTL_HOURS' | 'NODE_ENV'>;
  /** Login attempts allowed per client IP per minute (default 10). */
  loginRateLimit?: number;
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.user) throw new HttpProblem(401, 'unauthenticated', 'Login required');
  return { type: 'user', id: req.user.id, name: req.user.username, ip: req.ip };
}

export function requireRole(req: FastifyRequest, role: Role) {
  if (!req.user) throw new HttpProblem(401, 'unauthenticated', 'Login required');
  if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) throw new HttpProblem(403, 'forbidden', `Requires ${role} role`);
}

export const isAdmin = (req: FastifyRequest) => req.user?.role === 'admin';

export async function auditConfig(ctx: ApiContext, req: FastifyRequest, action: string, message: string, details: Record<string, unknown> = {}) {
  await ctx.s.audit.write({ severity: 'INFO', category: 'config', action, message, actor: actorOf(req), details });
}

export type Reply = FastifyReply;

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
export type Api = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, TypeBoxTypeProvider>;
