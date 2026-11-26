// Test driver: PGlite = real PostgreSQL compiled to WebAssembly, running in-process (no server).
import { PGlite } from '@electric-sql/pglite';
import type { PgDriver, PgQueryable } from '../../src/db/PostgresStore.js';

export function createPgliteDriver(dataDir?: string): PgDriver {
  const db = new PGlite(dataDir);
  const wrap = (q: { query: PGlite['query'] }): PgQueryable => ({
    async query(sql, params) {
      const r = await q.query<Record<string, unknown>>(sql, params as unknown[] | undefined);
      return { rows: r.rows, affectedRows: r.affectedRows };
    },
  });
  return {
    ...wrap(db),
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}
