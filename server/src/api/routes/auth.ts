import { Type } from 'typebox';
import type { Api, ApiContext } from '../context.js';
import { HttpProblem } from '../errors.js';
import { SESSION_COOKIE } from '../sessions.js';

export async function authRoutes(api: Api, ctx: ApiContext) {
  api.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: ctx.loginRateLimit ?? 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], body: Type.Object({ username: Type.String({ minLength: 1, maxLength: 100 }), password: Type.String({ minLength: 1, maxLength: 256 }) }) },
    },
    async (req, reply) => {
      const r = await ctx.sessions.login(req.body.username, req.body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
      if (!r.ok) {
        await ctx.s.audit.write({
          severity: r.reason === 'locked' ? 'WARNING' : 'INFO',
          category: 'auth',
          action: `login.${r.reason}`,
          message: `Failed login for "${req.body.username.slice(0, 100)}" (${r.reason})`,
          actor: { type: 'system', name: 'auth' },
          details: { ip: req.ip },
        });
        // Same message for unknown user, wrong password, locked or disabled.
        throw new HttpProblem(401, 'invalid_credentials', 'Invalid username or password');
      }
      await ctx.s.audit.write({ severity: 'INFO', category: 'auth', action: 'login', message: `${r.user.username} logged in`, actor: { type: 'user', id: r.user.id, name: r.user.username, ip: req.ip } });
      reply.setCookie(SESSION_COOKIE, r.token, {
        httpOnly: true,
        secure: ctx.config.FSM_COOKIE_SECURE,
        sameSite: 'strict',
        path: '/',
        maxAge: ctx.config.FSM_SESSION_TTL_HOURS * 3600,
      });
      return { user: { id: r.user.id, username: r.user.username, role: r.user.role }, csrfToken: r.user.csrfToken };
    },
  );

  api.post('/api/auth/logout', { config: { role: 'viewer' }, schema: { tags: ['auth'] } }, async (req, reply) => {
    await ctx.sessions.logout(req.user!.sessionHash);
    await ctx.s.audit.write({ severity: 'INFO', category: 'auth', action: 'logout', message: `${req.user!.username} logged out`, actor: { type: 'user', id: req.user!.id, name: req.user!.username, ip: req.ip } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  api.get('/api/auth/me', { config: { role: 'viewer' }, schema: { tags: ['auth'] } }, async (req) => ({
    user: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
    csrfToken: req.user!.csrfToken,
  }));
}
