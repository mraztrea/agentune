// Shared SQLite cache layer for discovery providers
// Avoids duplicated getCached/setCache across Apple and Smart Search providers

import type Database from 'better-sqlite3';

export class ProviderCache {
  constructor(
    private readonly db: Database.Database,
    private readonly ttlMs: number,
  ) {}

  get(key: string): unknown | null {
    const row = this.db.prepare(
      'SELECT response_json, fetched_at FROM provider_cache WHERE cache_key = ?',
    ).get(key) as { response_json: string; fetched_at: number } | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_at > this.ttlMs) return null;
    try {
      return JSON.parse(row.response_json);
    } catch {
      return null;
    }
  }

  set(key: string, data: unknown): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_cache (cache_key, response_json, fetched_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(data), Date.now());
  }

  /** Evict expired rows matching a key prefix (e.g. "apple:%") */
  evictExpired(prefix: string): void {
    this.db.prepare('DELETE FROM provider_cache WHERE cache_key LIKE ? AND fetched_at < ?')
      .run(`${prefix}%`, Date.now() - this.ttlMs);
  }
}
