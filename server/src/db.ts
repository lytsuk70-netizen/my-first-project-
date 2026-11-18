import pg from 'pg';

// BIGINT (int8) -> JS bigint, NUMERIC -> string, DATE -> 'YYYY-MM-DD' string. Never floats for money.
pg.types.setTypeParser(20, (v) => BigInt(v));
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://finance:finance@localhost:5432/finance',
  max: 10,
});

export type Db = pg.PoolClient | pg.Pool;

/** Runs fn inside a SERIALIZABLE-safe transaction: everything commits together or nothing does. */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(c: Db, userId: string, entity: string, entityId: string, action: string, before: unknown, after: unknown) {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  await c.query(
    'INSERT INTO audit_log (user_id, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, entity, entityId, action, json(before), json(after)],
  );
}
