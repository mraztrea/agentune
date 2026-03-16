// Taste Intelligence — tracks user preferences via implicit feedback signals
// Maintains taste state (obsessions/boredom/cravings), agent persona, and session lanes

import type { HistoryStore } from '../history/history-store.js';
import { normalizeTrackId } from '../history/history-schema.js';

// --- Taste State (4 core dimensions for MVP) ---
export interface TasteState {
  obsessions: Record<string, number>;  // "artist:nils frahm" -> 0.7
  boredom: Record<string, number>;     // "artist:nils frahm" -> 0.3
  cravings: string[];                  // ["warm", "minimal", "no-vocals"]
  noveltyAppetite: number;             // 0-1
  repeatTolerance: number;             // 0-1
  lastUpdatedAt: number;               // timestamp for time-based decay
}

// --- Agent Persona (separate from user prefs — controls transition style/curiosity) ---
export interface AgentPersona {
  curiosity: number;           // 0-1 — eagerness to explore unknown artists
  dramaticTransition: number;  // 0-1 — preference for big mood shifts
  callbackLove: number;        // 0-1 — tendency to return to previously enjoyed tracks
  antiMonotony: number;        // 0-1 — aggressiveness in avoiding repetition
}

// --- Session Lane (mood continuity — 2-5 song runs) ---
export interface SessionLane {
  description: string;   // e.g. "dark minimal instrumental"
  tags: string[];        // active tags
  songCount: number;     // songs played in this lane
  startedAt: number;     // timestamp
}

export interface TrackInfo {
  artist: string;
  title: string;
  duration?: number;
}

// --- Defaults ---
function defaultTasteState(): TasteState {
  return {
    obsessions: {},
    boredom: {},
    cravings: [],
    noveltyAppetite: 0.5,
    repeatTolerance: 0.5,
    lastUpdatedAt: Date.now(),
  };
}

function defaultPersona(): AgentPersona {
  return { curiosity: 0.4, dramaticTransition: 0.2, callbackLove: 0.5, antiMonotony: 0.6 };
}

const DECAY_BASE = 0.95;  // value * 0.95^hours — meaningful decay over hours
const DECAY_THRESHOLD = 0.01;  // prune values below this
const MIN_DECAY_HOURS = 0.1;   // skip decay if < 6 minutes since last update
const MAX_LANE_SONGS = 5;
const LANE_OVERLAP_THRESHOLD = 0.3;
const MAX_LANE_TAGS = 8;
const MAX_CRAVINGS = 6;

export class TasteEngine {
  private state: TasteState;
  private persona: AgentPersona;
  private lane: SessionLane | null;

  constructor(private readonly store: HistoryStore) {
    const saved = store.getSessionState();
    this.state = isValidTasteState(saved.tasteState) ? saved.tasteState : defaultTasteState();
    this.persona = isValidPersona(saved.agentPersona) ? saved.agentPersona : defaultPersona();
    this.lane = isValidLane(saved.lane) ? saved.lane : null;
  }

  /** Process implicit feedback after track play/skip. */
  processFeedback(track: TrackInfo, playedSec: number, totalSec: number, skipped: boolean): void {
    this.applyTimeDecay();

    const completionRatio = totalSec > 0 ? playedSec / totalSec : 0;
    const artistKey = `artist:${track.artist.toLowerCase()}`;

    // Update obsessions + boredom based on completion
    if (skipped && completionRatio < 0.3) {
      // Strong negative — early skip signals disinterest
      this.adjustObsession(artistKey, -0.1);
      this.adjustBoredom(artistKey, +0.15);
      this.state.noveltyAppetite = clamp(this.state.noveltyAppetite + 0.05);
      this.state.repeatTolerance = clamp(this.state.repeatTolerance - 0.03);
    } else if (skipped) {
      // Mild negative — listened partially then skipped
      this.adjustObsession(artistKey, -0.03);
      this.adjustBoredom(artistKey, +0.05);
    } else if (completionRatio > 0.85) {
      // Full play — positive signal
      this.adjustObsession(artistKey, +0.08);
      this.adjustBoredom(artistKey, -0.03);
      this.state.repeatTolerance = clamp(this.state.repeatTolerance + 0.02);
    }

    // Tag-level feedback (tags populated async by Apple genre enrichment — may be empty on first play)
    const trackId = normalizeTrackId(track.artist, track.title);
    const tags = this.store.getTrackTags(trackId);
    for (const tag of tags.slice(0, 5)) {
      const tagKey = `tag:${tag.toLowerCase()}`;
      if (skipped && completionRatio < 0.3) {
        this.adjustBoredom(tagKey, +0.05);
      } else if (completionRatio > 0.85) {
        this.adjustObsession(tagKey, +0.04);
      }
    }

    // Update cravings from recent tag patterns
    this.updateCravings(tags);

    // Update session lane
    this.updateLane(track);

    // Slowly evolve agent persona
    this.evolvePersona(completionRatio, skipped);

    this.persistState();
  }

  // --- Time-based decay: value * 0.95^hours ---
  private applyTimeDecay(): void {
    const now = Date.now();
    const hours = (now - this.state.lastUpdatedAt) / (1000 * 60 * 60);
    if (hours < MIN_DECAY_HOURS) return;

    const factor = Math.pow(DECAY_BASE, hours);
    pruneDecayed(this.state.obsessions, factor);
    pruneDecayed(this.state.boredom, factor);

    // Appetite drifts toward neutral over time
    this.state.noveltyAppetite += (0.5 - this.state.noveltyAppetite) * (1 - factor);
    this.state.repeatTolerance += (0.5 - this.state.repeatTolerance) * (1 - factor);
    this.state.lastUpdatedAt = now;
  }

  private adjustObsession(key: string, delta: number): void {
    this.state.obsessions[key] = clamp((this.state.obsessions[key] ?? 0) + delta);
    if (this.state.obsessions[key] < DECAY_THRESHOLD) delete this.state.obsessions[key];
  }

  private adjustBoredom(key: string, delta: number): void {
    this.state.boredom[key] = clamp((this.state.boredom[key] ?? 0) + delta);
    if (this.state.boredom[key] < DECAY_THRESHOLD) delete this.state.boredom[key];
  }

  // Cravings = top tags from recent obsessions
  private updateCravings(currentTags: string[]): void {
    const tagSet = new Set(this.state.cravings);
    const currentLower = new Set(currentTags.slice(0, 3).map((t) => t.toLowerCase()));
    for (const tag of currentLower) {
      tagSet.add(tag);
    }
    // Keep only tags that have active obsession or were just played
    const activeTags = [...tagSet].filter(
      (t) => (this.state.obsessions[`tag:${t}`] ?? 0) > 0.02 || currentLower.has(t),
    );
    this.state.cravings = activeTags.slice(0, MAX_CRAVINGS);
  }

  // --- Session Lane: mood continuity for 2-5 song runs ---
  private updateLane(track: TrackInfo): void {
    const trackId = normalizeTrackId(track.artist, track.title);
    const trackTags = this.store.getTrackTags(trackId);
    const effectiveTags = trackTags.length > 0 ? trackTags : [track.artist.toLowerCase()];

    if (!this.lane) {
      this.lane = {
        description: effectiveTags.slice(0, 3).join(' '),
        tags: effectiveTags.slice(0, MAX_LANE_TAGS),
        songCount: 1,
        startedAt: Date.now(),
      };
      return;
    }

    const overlap = tagOverlap(this.lane.tags, effectiveTags);
    if (overlap < LANE_OVERLAP_THRESHOLD || this.lane.songCount >= MAX_LANE_SONGS) {
      // Pivot to new lane
      this.lane = {
        description: effectiveTags.slice(0, 3).join(' '),
        tags: effectiveTags.slice(0, MAX_LANE_TAGS),
        songCount: 1,
        startedAt: Date.now(),
      };
    } else {
      this.lane.songCount++;
      this.lane.tags = [...new Set([...this.lane.tags, ...effectiveTags])].slice(0, MAX_LANE_TAGS);
      this.lane.description = this.lane.tags.slice(0, 3).join(' ');
    }
  }

  // Persona evolves very slowly from aggregate patterns
  private evolvePersona(completionRatio: number, skipped: boolean): void {
    const step = 0.01;
    if (skipped && completionRatio < 0.3) {
      this.persona.antiMonotony = clamp(this.persona.antiMonotony + step);
    }
    if (!skipped && completionRatio > 0.85) {
      // Full plays of known artists → increase callbackLove slightly
      this.persona.callbackLove = clamp(this.persona.callbackLove + step * 0.5);
    }
    // Curiosity increases when noveltyAppetite is high and plays succeed
    if (!skipped && this.state.noveltyAppetite > 0.6) {
      this.persona.curiosity = clamp(this.persona.curiosity + step * 0.5);
    }
  }

  private persistState(): void {
    try {
      this.store.saveSessionState({
        tasteState: this.state,
        agentPersona: this.persona,
        lane: this.lane,
      });
    } catch (err) {
      console.error('[sbotify] Failed to persist taste state:', (err as Error).message);
    }
  }

  // --- Public getters ---
  getState(): TasteState { return { ...this.state }; }
  getPersona(): AgentPersona { return { ...this.persona }; }
  getSessionLane(): SessionLane | null { return this.lane ? { ...this.lane } : null; }

  /** Human-readable summary for get_session_state MCP tool. */
  getSummary(): object {
    const topObsessions = topEntries(this.state.obsessions, 5);
    const topBoredom = topEntries(this.state.boredom, 5);

    // Recent plays from history
    const recentPlays = this.store.getRecent(5).map((p) => ({
      title: p.title,
      artist: p.artist,
      completion: p.duration_sec > 0 ? Math.min(1, p.played_sec / p.duration_sec) : 0,
      skipped: p.skipped === 1,
    }));

    return {
      taste: {
        obsessions: topObsessions.map(([key, strength]) => ({ key, strength: round2(strength) })),
        bored_of: topBoredom.map(([key, fatigue]) => ({ key, fatigue: round2(fatigue) })),
        cravings: this.state.cravings,
        noveltyAppetite: round2(this.state.noveltyAppetite),
        repeatTolerance: round2(this.state.repeatTolerance),
      },
      persona: {
        curiosity: round2(this.persona.curiosity),
        dramaticTransition: round2(this.persona.dramaticTransition),
        callbackLove: round2(this.persona.callbackLove),
        antiMonotony: round2(this.persona.antiMonotony),
      },
      lane: this.lane
        ? { description: this.lane.description, tags: this.lane.tags, songCount: this.lane.songCount }
        : null,
      recent: recentPlays,
    };
  }
}

// --- Helpers ---

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function pruneDecayed(map: Record<string, number>, factor: number): void {
  for (const key of Object.keys(map)) {
    map[key] *= factor;
    if (map[key] < DECAY_THRESHOLD) delete map[key];
  }
}

function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  return b.filter((t) => setA.has(t)).length / Math.max(a.length, b.length);
}

function topEntries(map: Record<string, number>, limit: number): [string, number][] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Type guards for loading persisted state ---

function isValidTasteState(v: unknown): v is TasteState {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.noveltyAppetite === 'number' &&
    typeof obj.lastUpdatedAt === 'number' &&
    typeof obj.obsessions === 'object' && obj.obsessions !== null &&
    typeof obj.boredom === 'object' && obj.boredom !== null &&
    Array.isArray(obj.cravings)
  );
}

function isValidPersona(v: unknown): v is AgentPersona {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.curiosity === 'number' &&
    typeof obj.antiMonotony === 'number' &&
    typeof obj.dramaticTransition === 'number' &&
    typeof obj.callbackLove === 'number'
  );
}

function isValidLane(v: unknown): v is SessionLane {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.description === 'string' && typeof obj.songCount === 'number' && Array.isArray(obj.tags);
}

// --- Singleton ---

let tasteEngine: TasteEngine | null = null;

export function createTasteEngine(store: HistoryStore): TasteEngine {
  if (!tasteEngine) {
    tasteEngine = new TasteEngine(store);
  }
  return tasteEngine;
}

export function getTasteEngine(): TasteEngine | null {
  return tasteEngine;
}
