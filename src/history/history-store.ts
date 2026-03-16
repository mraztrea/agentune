// SQLite-backed play history store — tracks, plays, preferences, session state
// Single entry point: createHistoryStore() on startup, getHistoryStore() elsewhere

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeTrackId, SCHEMA_SQL } from './history-schema.js';

export interface TrackRecord {
  id: string;
  title: string;
  artist: string;
  duration_sec: number;
  thumbnail: string;
  tags_json: string;
  similar_json: string;
  yt_video_id: string;
  first_played_at: number;
  play_count: number;
}

export interface PlayRecord {
  id: number;
  track_id: string;
  started_at: number;
  played_sec: number;
  skipped: number;
  context_json: string;
  lane_id: string;
}

export interface TrackInput {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  ytVideoId: string;
}

export interface CanonicalOverride {
  artist: string;
  title: string;
}

export interface PlayContext {
  context?: string;
  source?: string;
  [key: string]: unknown;
}

export interface SessionState {
  lane?: unknown;
  tasteState?: unknown;
  agentPersona?: unknown;
  currentIntent?: unknown;
}

export interface PreferenceRecord {
  key: string;
  weight: number;
  boredom: number;
  last_seen_at: number;
}

export class HistoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
  }

  /** Upsert track and insert play row. Returns playId. */
  recordPlay(
    track: TrackInput,
    context?: PlayContext,
    canonicalOverride?: CanonicalOverride,
  ): number {
    const artist = canonicalOverride?.artist ?? track.artist;
    const title = canonicalOverride?.title ?? track.title;
    const trackId = normalizeTrackId(artist, title);
    const now = Date.now();

    // Upsert track — increment play_count on conflict
    this.db.prepare(`
      INSERT INTO tracks (id, title, artist, duration_sec, thumbnail, yt_video_id, first_played_at, play_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        play_count = play_count + 1,
        duration_sec = excluded.duration_sec,
        thumbnail = excluded.thumbnail,
        yt_video_id = CASE WHEN excluded.yt_video_id != '' THEN excluded.yt_video_id ELSE yt_video_id END
    `).run(trackId, title, artist, track.duration, track.thumbnail, track.ytVideoId, now);

    // Insert play event
    const result = this.db.prepare(`
      INSERT INTO plays (track_id, started_at, context_json)
      VALUES (?, ?, ?)
    `).run(trackId, now, JSON.stringify(context ?? {}));

    return Number(result.lastInsertRowid);
  }

  /** Overwrite YouTube-derived artist/title with canonical values. */
  updateTrackCanonical(trackId: string, canonical: CanonicalOverride): void {
    this.db.prepare(`
      UPDATE tracks SET artist = ?, title = ? WHERE id = ?
    `).run(canonical.artist, canonical.title, trackId);
  }

  /** Update a play row (played duration, skip flag) in a single query. */
  updatePlay(playId: number, updates: { played_sec?: number; skipped?: boolean }): void {
    const sets: string[] = [];
    const params: (number)[] = [];
    if (updates.played_sec !== undefined) {
      sets.push('played_sec = ?');
      params.push(updates.played_sec);
    }
    if (updates.skipped !== undefined) {
      sets.push('skipped = ?');
      params.push(updates.skipped ? 1 : 0);
    }
    if (sets.length === 0) return;
    params.push(playId);
    this.db.prepare(`UPDATE plays SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** Return parsed tags_json for a track. */
  getTrackTags(trackId: string): string[] {
    const row = this.db.prepare('SELECT tags_json FROM tracks WHERE id = ?').get(trackId) as
      | { tags_json: string }
      | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.tags_json);
    } catch {
      return [];
    }
  }

  /** Recent plays with track info, optional text search. */
  getRecent(limit = 20, query?: string): Array<TrackRecord & { started_at: number; played_sec: number; skipped: number }> {
    const baseQuery = `
      SELECT t.*, p.started_at, p.played_sec, p.skipped
      FROM plays p
      JOIN tracks t ON t.id = p.track_id
      ${query ? 'WHERE t.title LIKE ? OR t.artist LIKE ?' : ''}
      ORDER BY p.started_at DESC
      LIMIT ?
    `;

    if (query) {
      const pattern = `%${query}%`;
      return this.db.prepare(baseQuery).all(pattern, pattern, limit) as Array<
        TrackRecord & { started_at: number; played_sec: number; skipped: number }
      >;
    }
    return this.db.prepare(baseQuery).all(limit) as Array<
      TrackRecord & { started_at: number; played_sec: number; skipped: number }
    >;
  }

  /** Play count, avg completion rate, skip rate for a track. */
  getTrackStats(trackId: string): { playCount: number; avgCompletion: number; skipRate: number } {
    const track = this.db.prepare('SELECT duration_sec, play_count FROM tracks WHERE id = ?')
      .get(trackId) as { duration_sec: number; play_count: number } | undefined;
    if (!track || track.play_count === 0) {
      return { playCount: 0, avgCompletion: 0, skipRate: 0 };
    }

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        AVG(CASE WHEN ? > 0 THEN CAST(played_sec AS REAL) / ? ELSE 0 END) as avg_completion,
        SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as skip_count
      FROM plays WHERE track_id = ?
    `).get(track.duration_sec, track.duration_sec, trackId) as {
      total: number; avg_completion: number; skip_count: number;
    };

    return {
      playCount: track.play_count,
      avgCompletion: Math.min(1, stats.avg_completion ?? 0),
      skipRate: stats.total > 0 ? stats.skip_count / stats.total : 0,
    };
  }

  /** Most played tracks with high completion rate. */
  getTopTracks(limit = 10): TrackRecord[] {
    return this.db.prepare(`
      SELECT * FROM tracks
      WHERE play_count > 0
      ORDER BY play_count DESC
      LIMIT ?
    `).all(limit) as TrackRecord[];
  }

  /** Play count for a specific artist/title combo. */
  getTrackPlayCount(artist: string, title: string): number {
    const trackId = normalizeTrackId(artist, title);
    const row = this.db.prepare('SELECT play_count FROM tracks WHERE id = ?')
      .get(trackId) as { play_count: number } | undefined;
    return row?.play_count ?? 0;
  }

  /** Hours since last play of a track (for repetition penalty). */
  hoursSinceLastPlay(artist: string, title: string): number {
    const trackId = normalizeTrackId(artist, title);
    const row = this.db.prepare(`
      SELECT MAX(started_at) as last_at FROM plays WHERE track_id = ?
    `).get(trackId) as { last_at: number | null } | undefined;
    if (!row?.last_at) return Infinity;
    return (Date.now() - row.last_at) / (1000 * 60 * 60);
  }

  /** Read singleton session_state row. */
  getSessionState(): SessionState {
    const row = this.db.prepare('SELECT * FROM session_state WHERE id = 1').get() as {
      lane_json: string; taste_state_json: string;
      agent_persona_json: string; current_intent_json: string;
    } | undefined;
    if (!row) return {};
    try {
      return {
        lane: JSON.parse(row.lane_json),
        tasteState: JSON.parse(row.taste_state_json),
        agentPersona: JSON.parse(row.agent_persona_json),
        currentIntent: JSON.parse(row.current_intent_json),
      };
    } catch {
      console.error('[sbotify] Corrupted session_state JSON — resetting to defaults.');
      return {};
    }
  }

  /** Upsert singleton session_state row. */
  saveSessionState(state: SessionState): void {
    this.db.prepare(`
      INSERT INTO session_state (id, lane_json, taste_state_json, agent_persona_json, current_intent_json)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        lane_json = excluded.lane_json,
        taste_state_json = excluded.taste_state_json,
        agent_persona_json = excluded.agent_persona_json,
        current_intent_json = excluded.current_intent_json
    `).run(
      JSON.stringify(state.lane ?? {}),
      JSON.stringify(state.tasteState ?? {}),
      JSON.stringify(state.agentPersona ?? {}),
      JSON.stringify(state.currentIntent ?? {}),
    );
  }

  /** Read a preference by key. */
  getPreference(key: string): PreferenceRecord | undefined {
    return this.db.prepare('SELECT * FROM preferences WHERE key = ?')
      .get(key) as PreferenceRecord | undefined;
  }

  /** Upsert a preference. */
  setPreference(key: string, weight: number, boredom: number): void {
    this.db.prepare(`
      INSERT INTO preferences (key, weight, boredom, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        weight = excluded.weight,
        boredom = excluded.boredom,
        last_seen_at = excluded.last_seen_at
    `).run(key, weight, boredom, Date.now());
  }

  /** Expose underlying database for cache access (Last.fm provider). */
  getDatabase(): Database.Database {
    return this.db;
  }

  /** Update tags_json for a track by ID. */
  updateTrackTags(trackId: string, tags: string[]): void {
    this.db.prepare('UPDATE tracks SET tags_json = ? WHERE id = ?')
      .run(JSON.stringify(tags), trackId);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// -- Singleton --

let historyStore: HistoryStore | null = null;

export function createHistoryStore(): HistoryStore {
  if (!historyStore) {
    const dataDir = process.env.SBOTIFY_DATA_DIR || path.join(os.homedir(), '.sbotify');
    const dbPath = path.join(dataDir, 'history.db');
    historyStore = new HistoryStore(dbPath);
    console.error(`[sbotify] History DB initialized at ${dbPath}`);
  }
  return historyStore;
}

export function getHistoryStore(): HistoryStore | null {
  return historyStore;
}
