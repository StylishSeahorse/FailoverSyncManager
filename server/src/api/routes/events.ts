import { Type } from 'typebox';
import type { AuditCategory, Severity } from '../../audit/audit.js';
import { isUuid } from '../../repos/sql.js';
import type { Api, ApiContext } from '../context.js';
import { badRequest } from '../errors.js';

const SEVERITIES = ['DEBUG', 'INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'];
const CATEGORIES = ['auth', 'config', 'health', 'failover', 'change', 'provider', 'system', 'security'];

export async function eventRoutes(api: Api, ctx: ApiContext) {
  api.get(
    '/api/events',
    {
      config: { role: 'viewer' },
      schema: {
        tags: ['events'],
        summary: 'Searchable, filterable audit log (keyset pagination via before)',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          severity: Type.Optional(Type.String({ description: 'Comma separated' })),
          category: Type.Optional(Type.String({ description: 'Comma separated' })),
          siteId: Type.Optional(Type.String()),
          applicationId: Type.Optional(Type.String()),
          operationId: Type.Optional(Type.String()),
          from: Type.Optional(Type.String({ format: 'date-time' })),
          to: Type.Optional(Type.String({ format: 'date-time' })),
          before: Type.Optional(Type.Integer({ minimum: 1 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const list = (v: string | undefined, allowed: string[]) => {
        if (!v) return undefined;
        const items = v.split(',').map((x) => x.trim()).filter(Boolean);
        const bad = items.filter((i) => !allowed.includes(i));
        if (bad.length) throw badRequest(`Unknown value(s): ${bad.join(', ')}`);
        return items;
      };
      for (const id of [q.siteId, q.applicationId, q.operationId]) if (id && !isUuid(id)) throw badRequest('Invalid id');
      return ctx.s.audit.query({
        q: q.q,
        severity: list(q.severity, SEVERITIES) as Severity[] | undefined,
        category: list(q.category, CATEGORIES) as AuditCategory[] | undefined,
        siteId: q.siteId,
        applicationId: q.applicationId,
        operationId: q.operationId,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        before: q.before,
        limit: q.limit,
      });
    },
  );
}
