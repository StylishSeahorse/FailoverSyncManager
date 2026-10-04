import type { Db, Queryable } from '../db/pool.js';
import type { SecretBox } from './secretBox.js';

/**
 * Persists encrypted credentials. Decrypted values are cached in memory only
 * so that the redactor can scrub them from any log line or error message.
 */
export class SecretStore {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Creates or replaces a secret; returns its id. */
  async put(purpose: string, plaintext: string, existingId?: string | null, q: Queryable = this.db): Promise<string> {
    const enc = this.box.encrypt(plaintext, purpose);
    if (existingId) {
      const res = await q.query(
        `UPDATE secrets SET ciphertext=$2, iv=$3, auth_tag=$4, key_version=$5, purpose=$6, updated_at=now() WHERE id=$1 RETURNING id`,
        [existingId, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion, purpose],
      );
      if (res.rowCount) {
        this.cache.set(existingId, plaintext);
        return existingId;
      }
    }
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO secrets(purpose, ciphertext, iv, auth_tag, key_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [purpose, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion],
    );
    this.cache.set(rows[0]!.id, plaintext);
    return rows[0]!.id;
  }

  async get(id: string, purpose: string): Promise<string> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const { rows } = await this.db.query(`SELECT ciphertext, iv, auth_tag, key_version FROM secrets WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new Error('Secret not found');
    const value = this.box.decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version }, purpose);
    this.cache.set(id, value);
    return value;
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM secrets WHERE id = $1', [id]);
    this.cache.delete(id);
  }

  /** Decrypts every stored secret into the cache at startup, so redaction knows all values. */
  async warm(): Promise<void> {
    const { rows } = await this.db.query<{ id: string; purpose: string }>('SELECT id, purpose FROM secrets');
    for (const r of rows) await this.get(r.id, r.purpose).catch(() => undefined);
  }

  knownValues(): string[] {
    return [...this.cache.values()];
  }
}
