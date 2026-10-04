import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { Role, User } from '../domain/types.js';
import { camelRow } from '../repos/sql.js';
import { hashPassword, verifyPassword } from '../security/password.js';

export const SESSION_COOKIE = 'fsm_session';
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  csrfToken: string;
  sessionHash: string;
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled'; user?: User };

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** Server-side sessions. Only the SHA-256 of the cookie token is stored. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttlHours: number,
    private readonly idleMinutes: number,
  ) {}

  async login(username: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0] ? camelRow<User>(rows[0]) : null;
    if (!user) {
      // Spend comparable time so usernames cannot be enumerated by timing.
      await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      return { ok: false, reason: 'invalid' };
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) return { ok: false, reason: 'locked', user };
    if (user.disabled) return { ok: false, reason: 'disabled', user };
    if (!(await verifyPassword(password, user.passwordHash))) {
      const failed = user.failedLogins + 1;
      await this.db.query(
        `UPDATE users SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE id = $1`,
        [user.id, failed, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
      );
      return { ok: false, reason: failed >= MAX_FAILED_LOGINS ? 'locked' : 'invalid', user };
    }
    await this.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const hash = sha256(token);
    await this.db.query(
      `INSERT INTO sessions(id_hash, user_id, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6::int))`,
      [hash, user.id, csrf, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, this.ttlHours],
    );
    return { ok: true, token, user: { id: user.id, username: user.username, role: user.role, csrfToken: csrf, sessionHash: hash } };
  }

  async validate(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 200) return null;
    const hash = sha256(token);
    const { rows } = await this.db.query(
      `UPDATE sessions s SET last_seen_at = now()
       FROM users u
       WHERE s.id_hash = $1 AND u.id = s.user_id AND NOT u.disabled
         AND s.expires_at > now() AND s.last_seen_at > now() - ($2 || ' minutes')::interval
       RETURNING u.id, u.username, u.role, s.csrf_token`,
      [hash, String(this.idleMinutes)],
    );
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, username: r.username, role: r.role, csrfToken: r.csrf_token, sessionHash: hash };
  }

  async logout(sessionHash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE id_hash = $1', [sessionHash]);
  }

  async revokeUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async purgeExpired(): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - ($1 || ' minutes')::interval`, [String(this.idleMinutes)]);
  }

  static csrfMatches(expected: string, provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Creates the first administrator from configuration when no users exist. */
  async bootstrapAdmin(username: string | undefined, password: string | undefined): Promise<'created' | 'exists' | 'missing'> {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n > 0) return 'exists';
    if (!username || !password) return 'missing';
    await this.db.query(`INSERT INTO users(username, password_hash, role) VALUES ($1, $2, 'admin')`, [username, await hashPassword(password)]);
    return 'created';
  }
}
