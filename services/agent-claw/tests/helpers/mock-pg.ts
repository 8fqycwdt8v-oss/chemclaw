// Test helper: lightweight mock for pg.Pool and pg.PoolClient.
// Usage:
//   const { pool, client, querySpy } = mockPool();
//   client.queryResults.push({ rows: [...], rowCount: 1 });
//   await withUserContext(pool, 'user@example.com', async (c) => { ... });

import { vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";

export interface MockClient {
  /** Canned query results — dequeued in order (FIFO). If empty, returns empty rows. */
  queryResults: Array<Partial<QueryResult>>;
  /** Spy on query calls to assert what SQL was executed. */
  querySpy: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export interface MockPool {
  pool: Pool;
  client: MockClient;
}

export function mockPool(): MockPool {
  const mockClient: MockClient = {
    queryResults: [],
    querySpy: vi.fn(),
    release: vi.fn(),
  };

  // Build a real-ish client that dequeues from queryResults.
  const clientObj = {
    query: mockClient.querySpy.mockImplementation(async () => {
      const next = mockClient.queryResults.shift();
      return next ?? { rows: [], rowCount: 0 };
    }),
    release: mockClient.release,
  } as unknown as PoolClient;

  const poolObj = {
    connect: vi.fn().mockResolvedValue(clientObj),
    query: vi.fn().mockImplementation(async () => {
      const next = mockClient.queryResults.shift();
      return next ?? { rows: [], rowCount: 0 };
    }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;

  return { pool: poolObj, client: mockClient };
}
