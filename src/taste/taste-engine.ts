// Agent-first taste engine — reads stored manual persona traits,
// provides time context, and manages free-text persona taste description.
// Listening history stays as context, not the trait source.

import type { HistoryStore } from '../history/history-store.js';

// --- Interfaces ---

export interface PersonaTraits {
  exploration: number;
  variety: number;
  loyalty: number;
}

export interface TimeContext {
  hour: number;
  period: 'morning' | 'afternoon' | 'evening' | 'night';
  dayOfWeek: string;
}

export interface SessionSummary {
  context: TimeContext;
  persona: { traits: PersonaTraits; taste: string };
  history: {
    recent: Array<{ title: string; artist: string; completion: number; skipped: boolean }>;
    stats: { topArtists: Array<{ artist: string; plays: number }>; topTags: Array<{ tag: string; frequency: number }> };
  };
}

// --- Constants ---

const MAX_TASTE_TEXT_LENGTH = 1000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DEFAULT_PERSONA_TRAITS: PersonaTraits = {
  exploration: 0.5,
  variety: 0.5,
  loyalty: 0.5,
};

// --- TasteEngine ---

export class TasteEngine {
  constructor(private readonly store: HistoryStore) {}

  /** Read persisted manual persona traits. */
  getTraits(): PersonaTraits {
    return this.store.getPersonaTraits();
  }

  /** Save persisted manual persona traits. */
  saveTraits(traits: PersonaTraits): PersonaTraits {
    this.store.savePersonaTraits(traits);
    return this.getTraits();
  }

  /** Current time context for agent decision-making. */
  getTimeContext(): TimeContext {
    const now = new Date();
    const hour = now.getHours();
    return {
      hour,
      period: hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening',
      dayOfWeek: DAYS[now.getDay()],
    };
  }

  /** Read persisted free-text taste description. */
  getTasteText(): string {
    return this.store.getPersonaTasteText();
  }

  /** Save free-text taste description (max 1000 chars). */
  saveTasteText(text: string): void {
    this.store.savePersonaTasteText(text.slice(0, MAX_TASTE_TEXT_LENGTH));
  }

  /** Read the full persisted persona payload. */
  getPersona(): { traits: PersonaTraits; taste: string } {
    return {
      traits: this.getTraits(),
      taste: this.getTasteText(),
    };
  }

  /** Full session summary for get_session_state MCP tool. */
  getSummary(): SessionSummary {
    const recent = this.store.getRecentPlaysDetailed(5);
    const topArtists = this.store.getTopArtists(5);
    const topTags = this.store.getTopTags(5);

    return {
      context: this.getTimeContext(),
      persona: this.getPersona(),
      history: {
        recent: recent.map(r => ({
          title: r.title,
          artist: r.artist,
          completion: round2(r.completion),
          skipped: r.skipped,
        })),
        stats: {
          topArtists: topArtists.map(a => ({ artist: a.artist, plays: a.plays })),
          topTags: topTags.map(t => ({ tag: t.tag, frequency: t.frequency })),
        },
      },
    };
  }
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Singleton ---

let tasteEngine: TasteEngine | null = null;
let tasteEngineStore: HistoryStore | null = null;

export function createTasteEngine(store: HistoryStore): TasteEngine {
  if (!tasteEngine || tasteEngineStore !== store) {
    tasteEngine = new TasteEngine(store);
    tasteEngineStore = store;
  }
  return tasteEngine;
}

export function getTasteEngine(): TasteEngine | null {
  return tasteEngine;
}
