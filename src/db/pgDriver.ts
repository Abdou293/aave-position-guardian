// Production Postgres driver (node-postgres connection pool) for PostgresStore.
import pg from 'pg';
import type { PgDriver, PgQueryable } from './PostgresStore.js';

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

export function createPgDriver(connectionString: string): PgDriver {
  // Hosted databases (Neon, Render, Supabase) require TLS: add `?sslmode=require` to the URL.
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  // An idle client error must not crash the app; the next query reconnects.
  pool.on('error', () => undefined);
  const wrap = (c: { query: pg.Pool['query'] }): PgQueryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Record<string, unknown>[], affectedRows: r.rowCount ?? undefined };
    },
  });
  return {
    ...wrap(pool),
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client as unknown as { query: pg.Pool['query'] }));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
