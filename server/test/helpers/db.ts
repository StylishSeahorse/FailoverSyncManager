import { randomBytes } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { createPool, type Db } from '../../src/db/pool.js';

export interface TestDb {
  db: Db;
  schema: string;
  close(): Promise<void>;
}

/** Fresh, fully migrated schema for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL!;
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = createPool(url, schema);
  await migrate(db);
  return {
    db,
    schema,
    async close() {
      await db.end();
      const a = createPool(url);
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}
