import { Type } from 'typebox';
import { camelRow, isUuid } from '../../repos/sql.js';
import type { User } from '../../domain/types.js';
import { hashPassword, passwordProblems } from '../../security/password.js';
import { auditConfig, type Api, type ApiContext } from '../context.js';
import { badRequest, HttpProblem, notFound } from '../errors.js';

const Role = Type.Union([Type.Literal('admin'), Type.Literal('operator'), Type.Literal('viewer')]);
const view = (u: User) => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled, lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil, createdAt: u.createdAt });

export async function userRoutes(api: Api, ctx: ApiContext) {
  const db = ctx.s.db;
  const get = async (id: string) => {
    if (!isUuid(id)) return null;
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? camelRow<User>(rows[0]) : null;
  };

  api.get('/api/users', { config: { role: 'admin' }, schema: { tags: ['users'] } }, async () => {
    const { rows } = await db.query('SELECT * FROM users ORDER BY username');
    return rows.map((r) => view(camelRow<User>(r)));
  });

  api.post(
    '/api/users',
    { config: { role: 'admin' }, schema: { tags: ['users'], body: Type.Object({ username: Type.String({ pattern: '^[a-zA-Z0-9._@-]{2,64}$' }), password: Type.String(), role: Role }) } },
    async (req, reply) => {
      const problems = passwordProblems(req.body.password);
      if (problems.length) throw badRequest(`Password ${problems.join(', ')}`);
      const { rows } = await db.query(`INSERT INTO users(username, password_hash, role) VALUES ($1,$2,$3) RETURNING *`, [req.body.username, await hashPassword(req.body.password), req.body.role]);
      await auditConfig(ctx, req, 'user.created', `User ${req.body.username} created with role ${req.body.role}`);
      return reply.status(201).send(view(camelRow<User>(rows[0])));
    },
  );

  api.patch(
    '/api/users/:id',
    {
      config: { role: 'admin' },
      schema: { tags: ['users'], params: Type.Object({ id: Type.String() }), body: Type.Object({ role: Type.Optional(Role), disabled: Type.Optional(Type.Boolean()), password: Type.Optional(Type.String()) }) },
    },
    async (req) => {
      const u = await get(req.params.id);
      if (!u) throw notFound('User');
      if (u.id === req.user!.id && ((req.body.role && req.body.role !== 'admin') || req.body.disabled)) {
        throw new HttpProblem(409, 'self_lockout', 'You cannot demote or disable your own account');
      }
      if (req.body.password !== undefined) {
        const problems = passwordProblems(req.body.password);
        if (problems.length) throw badRequest(`Password ${problems.join(', ')}`);
        await db.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id, await hashPassword(req.body.password)]);
      }
      if (req.body.role) await db.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [u.id, req.body.role]);
      if (req.body.disabled !== undefined) await db.query('UPDATE users SET disabled = $2, updated_at = now() WHERE id = $1', [u.id, req.body.disabled]);
      if (req.body.disabled || req.body.password !== undefined || req.body.role) await ctx.sessions.revokeUser(u.id);
      await auditConfig(ctx, req, 'user.updated', `User ${u.username} updated`, { role: req.body.role, disabled: req.body.disabled, passwordChanged: req.body.password !== undefined });
      return view((await get(u.id))!);
    },
  );

  api.delete('/api/users/:id', { config: { role: 'admin' }, schema: { tags: ['users'], params: Type.Object({ id: Type.String() }) } }, async (req) => {
    const u = await get(req.params.id);
    if (!u) throw notFound('User');
    if (u.id === req.user!.id) throw new HttpProblem(409, 'self_lockout', 'You cannot delete your own account');
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    await auditConfig(ctx, req, 'user.deleted', `User ${u.username} deleted`);
    return { ok: true };
  });
}
