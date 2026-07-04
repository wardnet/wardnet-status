/** Single home for the meta-table upsert used across the worker. */
export function metaUpsert(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);
}

export async function metaGet(db: D1Database, key: string): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value;
}

/**
 * D1-backed storage adapter for the topology last-known-good cache. Lives in
 * D1 (meta table) rather than DO storage so both the cron fan-out and the API
 * share one cache and one staleness view. Keys are stored as-is — callers pass
 * fully-namespaced keys (e.g. "topology:last-good").
 */
export function d1TopologyStorage(db: D1Database) {
  return {
    async get(key: string): Promise<unknown> {
      const value = await metaGet(db, key);
      return value === undefined ? undefined : JSON.parse(value);
    },
    async put(key: string, value: unknown): Promise<void> {
      await metaUpsert(db, key, JSON.stringify(value)).run();
    },
  };
}
