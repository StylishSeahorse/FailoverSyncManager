/**
 * Local demo: the full controller and dashboard API against fake
 * Cloudflare, Proxmox, NPM and application servers on 127.0.0.1. Nothing
 * real is contacted. Needs DATABASE_URL (a scratch schema is created and
 * dropped on exit).
 *
 *   DATABASE_URL=postgres://... npm run demo -w server
 *   npm run dev -w web           # then open http://localhost:5173
 *
 * Sign in as admin / operator with password "demo password 123".
 * Type k + Enter to take Site A down, r + Enter to bring it back.
 */
import { buildApp } from '../src/api/app.js';
import { SessionService } from '../src/api/sessions.js';
import { hashPassword } from '../src/security/password.js';
import { World } from './helpers/world.js';

const PASSWORD = 'demo password 123';

const w = await new World(3).start();
await w.t.db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
await w.t.db.query(`INSERT INTO users(username, password_hash, role) VALUES ('viewer', $1, 'viewer')`, [await hashPassword(PASSWORD)]);
const app = await buildApp({ s: w.s, sessions: new SessionService(w.t.db, 12, 30), config: { FSM_COOKIE_SECURE: false, FSM_SESSION_TTL_HOURS: 12, NODE_ENV: 'development' } });
await app.listen({ host: '127.0.0.1', port: Number(process.env.FSM_PORT ?? 8080) });
await w.observe(2);
const timer = setInterval(() => void w.observe(1).catch((e) => console.error('observe failed', e)), 5000);

console.log(`Demo API on http://127.0.0.1:${process.env.FSM_PORT ?? 8080} (users admin, operator, viewer; password "${PASSWORD}")`);
console.log('Type k + Enter to take Site A down, r + Enter to restore it.');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => {
  const c = d.trim();
  if (c === 'k') void w.killSiteA().then(() => console.log('Site A is down'));
  if (c === 'r') void w.restoreSiteA().then(() => console.log('Site A restored'));
});

const stop = async () => {
  clearInterval(timer);
  await app.close();
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
