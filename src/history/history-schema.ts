// SQLite schema definitions and track ID normalization for play history

/**
 * Normalize artist + title into a deterministic track ID.
 * Collapses whitespace and lowercases for dedup.
 * Example: normalizeTrackId("Nils  Frahm", "Says") → "nils frahm::says"
 */
export function normalizeTrackId(artist: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${norm(artist)}::${norm(title)}`;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  duration_sec INTEGER DEFAULT 0,
  thumbnail TEXT DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  similar_json TEXT DEFAULT '[]',
  yt_video_id TEXT DEFAULT '',
  first_played_at INTEGER NOT NULL,
  play_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  started_at INTEGER NOT NULL,
  played_sec INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}',
  lane_id TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  weight REAL DEFAULT 0,
  boredom REAL DEFAULT 0,
  last_seen_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lane_json TEXT DEFAULT '{}',
  taste_state_json TEXT DEFAULT '{}',
  agent_persona_json TEXT DEFAULT '{}',
  current_intent_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS lastfm_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plays_track_id ON plays(track_id);
CREATE INDEX IF NOT EXISTS idx_plays_started_at ON plays(started_at);
CREATE INDEX IF NOT EXISTS idx_preferences_weight ON preferences(weight);
`;
