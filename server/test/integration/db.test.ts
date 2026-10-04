import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pendingMigrations } from '../../src/db/migrate.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

describe('migrations', () => {
  it('applies cleanly and is idempotent', async () => {
    expect(await pendingMigrations(t.db)).toEqual([]);
    expect(await migrate(t.db)).toEqual([]);
  });

  it('makes the audit log append-only', async () => {
    const { rows } = await t.db.query(
      `INSERT INTO audit_events(severity, category, action, message, actor_type, actor_name)
       VALUES ('INFO','system','test','hello','system','system') RETURNING id`,
    );
    await expect(t.db.query('UPDATE audit_events SET message = $1 WHERE id = $2', ['x', rows[0].id])).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM audit_events WHERE id = $1', [rows[0].id])).rejects.toThrow(/append-only/);
  });

  it('refuses DNS records whose primary and secondary targets are equal', async () => {
    const acct = await t.db.query(`INSERT INTO cloudflare_accounts(name, account_id) VALUES ('cf','acc') RETURNING id`);
    const zone = await t.db.query(
      `INSERT INTO cloudflare_zones(cloudflare_account_id, zone_id, name) VALUES ($1,'z1','example.com') RETURNING id`,
      [acct.rows[0].id],
    );
    const app = await t.db.query(`INSERT INTO applications(slug, name) VALUES ('wp','WordPress') RETURNING id`);
    await expect(
      t.db.query(
        `INSERT INTO dns_records(application_id, zone_id, record_id, name, type, primary_content, secondary_content)
         VALUES ($1,$2,'r1','app.example.com','CNAME','same','same')`,
        [app.rows[0].id, zone.rows[0].id],
      ),
    ).rejects.toThrow();
  });

  it('allows only one designated primary site', async () => {
    await t.db.query(`INSERT INTO sites(code, name, designated_role) VALUES ('A','Site A','primary')`);
    await expect(t.db.query(`INSERT INTO sites(code, name, designated_role) VALUES ('C','Site C','primary')`)).rejects.toThrow();
  });
});
