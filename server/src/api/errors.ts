import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { OperationConflictError, PreconditionError } from '../orchestrator/orchestrator.js';
import { ProviderError } from '../providers/errors.js';
import { ProviderConfigError } from '../providers/registry.js';
import { InvalidTransitionError } from '../state/failoverMachine.js';
import { InvalidSiteTransitionError } from '../state/siteMachine.js';
import { SplitBrainError, StaleStateError } from '../state/store.js';

export class HttpProblem extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpProblem(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: Record<string, unknown>) => new HttpProblem(400, 'bad_request', message, details);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, error: string, message: string, details?: Record<string, unknown>) =>
    reply.status(status).send({ error, message, ...(details ? { details } : {}) });

  if (err instanceof HttpProblem) return send(err.statusCode, err.code, err.message, err.details);
  if (err instanceof PreconditionError) return send(422, 'precondition_failed', err.message, { blockers: err.blockers });
  if (err instanceof OperationConflictError || err instanceof InvalidTransitionError || err instanceof InvalidSiteTransitionError || err instanceof StaleStateError)
    return send(409, 'conflict', err.message);
  if (err instanceof SplitBrainError) return send(409, 'split_brain_prevented', err.message);
  if (err instanceof ProviderConfigError) return send(400, 'provider_not_configured', err.message);
  if (err instanceof ProviderError) return send(502, `provider_${err.kind ?? 'error'}`, err.message);
  const fe = err as FastifyError;
  if (fe.validation) return send(400, 'validation_error', fe.message);
  if (fe.statusCode === 429) return send(429, 'rate_limited', 'Too many requests');
  if (fe.statusCode && fe.statusCode < 500) return send(fe.statusCode, fe.code ?? 'error', fe.message);
  // Postgres unique / FK violations
  const pg = err as { code?: string; detail?: string };
  if (pg.code === '23505') return send(409, 'duplicate', 'An object with these unique fields already exists');
  if (pg.code === '23503') return send(409, 'in_use', 'Referenced object does not exist or is still in use');
  if (pg.code === '23514' || pg.code === '22P02') return send(400, 'invalid_value', 'A value is outside its allowed range');
  req.log.error({ err }, 'unhandled error');
  return send(500, 'internal_error', 'Internal error');
}
