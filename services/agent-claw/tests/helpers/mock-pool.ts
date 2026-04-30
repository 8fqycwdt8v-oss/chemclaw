// Shared mock Pool for tests that exercise withUserContext / withSystemContext.
//
// Both helpers call BEGIN, SET LOCAL via set_config(...), the data SQL,
// then COMMIT — the transaction-control SQL would otherwise show up in
// the test's `.toHaveBeenCalledTimes()` assertions and break call-counting.
// This helper transparently no-ops the transaction-control statements and
// routes data SQL to a configurable handler whose return value is what the
// test wants the SELECT/UPDATE/INSERT to produce.
//
// Replaces three near-identical implementations that lived in
// tests/unit/manage-todos.test.ts, tests/unit/prompts-registry.test.ts,
// and tests/unit/skills-db.test.ts. Centralising them prevents drift —
// e.g. when withUserContext starts issuing SAVEPOINT we update one place.

import { vi } from "vitest";
import type { Pool, QueryResult } from "pg";

type DataHandler = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const DEFAULT_EMPTY: QueryResult = {
  rows: [],
  rowCount: 0,
  command: "",
  oid: 0,
  fields: [],
};

function isTxControl(sql: unknown): boolean {
  if (typeof sql !== "string") return false;
  const s = sql.toUpperCase().trim();
  return (
    s.startsWith("BEGIN") ||
    s.startsWith("COMMIT") ||
    s.startsWith("ROLLBACK") ||
    s.includes("SET_CONFIG")
  );
}

export interface MockPoolHandle {
  /** The mock Pool to inject into code under test. */
  pool: Pool;
  /** vi.fn() spy that DATA queries go through (transaction-control bypassed). */
  dataSpy: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock Pool whose `connect()` returns a client whose `query()`
 * routes DATA queries to `dataHandler` and silently no-ops transaction-
 * control SQL. Tests can assert on `dataSpy.mock.calls` to inspect what
 * the production code actually queried, without seeing BEGIN/COMMIT/
 * SET_CONFIG noise.
 */
export function createMockPool(opts: {
  /** Called for non-transaction-control queries. Receives the SQL + params. */
  dataHandler?: DataHandler;
} = {}): MockPoolHandle {
  const dataSpy = vi.fn<Parameters<DataHandler>, ReturnType<DataHandler>>();
  if (opts.dataHandler) {
    dataSpy.mockImplementation(opts.dataHandler);
  } else {
    dataSpy.mockResolvedValue(DEFAULT_EMPTY);
  }

  const dispatch = async (sql: unknown, params?: unknown[]): Promise<QueryResult> => {
    if (isTxControl(sql)) return DEFAULT_EMPTY;
    return dataSpy(sql as string, params);
  };

  const pool = {
    query: dispatch,
    connect: vi.fn(async () => ({
      query: dispatch,
      release: vi.fn(),
    })),
  } as unknown as Pool;

  return { pool, dataSpy };
}
