import pg from 'pg';

// Return BIGINT/BIGSERIAL as JS numbers (ids stay well below 2^53) and keep
// timestamptz as Date.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, schema?: string): Db {
  return new pg.Pool({
    connectionString,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
