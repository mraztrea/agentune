// 4-lane candidate generation for discover pipeline
// Lanes: continuation (similar tracks), comfort (top played), context-fit (tag match), wildcard (explore)

import type { LastFmProvider } from '../providers/lastfm-provider.js';
import type { HistoryStore } from '../history/history-store.js';
import type { TasteEngine, TrackInfo, SessionLane } from './taste-engine.js';

export interface MusicIntent {
  energy?: number;       // 0=calm, 1=energetic
  valence?: number;      // 0=dark, 1=bright
  novelty?: number;      // 0=familiar, 1=new
  allowed_tags?: string[];
  avoid_tags?: string[];
}

export interface Candidate {
  title: string;
  artist: string;
  source: 'continuation' | 'comfort' | 'context_fit' | 'wildcard';
  sourceDetail: string;
  tags?: string[];
}

const LANE_RATIOS = {
  focus:    { continuation: 0.50, comfort: 0.30, context_fit: 0.15, wildcard: 0.05 },
  balanced: { continuation: 0.40, comfort: 0.30, context_fit: 0.20, wildcard: 0.10 },
  explore:  { continuation: 0.20, comfort: 0.15, context_fit: 0.30, wildcard: 0.35 },
} as const;

export type DiscoverMode = keyof typeof LANE_RATIOS;

export class CandidateGenerator {
  constructor(
    private readonly lastFm: LastFmProvider | null,
    private readonly historyStore: HistoryStore,
    private readonly tasteEngine: TasteEngine,
  ) {}

  async generate(
    currentTrack: TrackInfo | null,
    intent?: MusicIntent,
    mode: DiscoverMode = 'balanced',
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    // Lane A: Continuation — similar tracks from current track via Last.fm
    if (currentTrack && this.lastFm) {
      try {
        const similar = await this.lastFm.getSimilarTracks(currentTrack.artist, currentTrack.title, 8);
        for (const s of similar) {
          candidates.push({
            title: s.title, artist: s.artist,
            source: 'continuation',
            sourceDetail: `similar to ${currentTrack.title}`,
          });
        }
      } catch (err) {
        console.error('[sbotify] Lane A (continuation) failed:', (err as Error).message);
      }
    }

    // Lane B: Comfort — most-played tracks from history
    try {
      const topPlayed = this.historyStore.getTopTracks(6);
      for (const t of topPlayed) {
        candidates.push({
          title: t.title, artist: t.artist,
          source: 'comfort',
          sourceDetail: `played ${t.play_count} times`,
        });
      }
    } catch (err) {
      console.error('[sbotify] Lane B (comfort) failed:', (err as Error).message);
    }

    // Lane C: Context Fit — tracks matching intent tags or session lane tags
    const lane = this.tasteEngine.getSessionLane();
    const contextTags = intent?.allowed_tags ?? lane?.tags ?? [];
    if (contextTags.length > 0 && this.lastFm) {
      const selectedTags = contextTags.slice(0, 2);
      for (const tag of selectedTags) {
        try {
          const tagTracks = await this.lastFm.getTopTracksByTag(tag, 4);
          for (const t of tagTracks) {
            candidates.push({
              title: t.title, artist: t.artist,
              source: 'context_fit',
              sourceDetail: `matches tag: ${tag}`,
              tags: [tag],
            });
          }
        } catch (err) {
          console.error(`[sbotify] Lane C (context_fit) tag "${tag}" failed:`, (err as Error).message);
        }
      }
    }

    // Lane D: Wildcard — pick a similar artist, get THEIR similar tracks
    if (currentTrack && this.lastFm) {
      try {
        const similarArtists = await this.lastFm.getSimilarArtists(currentTrack.artist, 3);
        if (similarArtists.length > 0) {
          const pick = similarArtists[Math.floor(Math.random() * similarArtists.length)];
          // Get similar tracks for a track by this artist (uses Last.fm track.getsimilar)
          const artistSimilar = await this.lastFm.getSimilarTracks(pick.name, currentTrack.title, 2);
          for (const t of artistSimilar) {
            candidates.push({
              title: t.title, artist: t.artist,
              source: 'wildcard',
              sourceDetail: `exploring via ${pick.name}`,
            });
          }
        }
      } catch (err) {
        console.error('[sbotify] Lane D (wildcard) failed:', (err as Error).message);
      }
    }

    // Filter out avoided tags if specified
    const avoidSet = new Set((intent?.avoid_tags ?? []).map(t => t.toLowerCase()));
    const filtered = avoidSet.size > 0
      ? candidates.filter(c => !c.tags?.some(t => avoidSet.has(t.toLowerCase())))
      : candidates;

    // Apply lane ratios — trim each lane proportionally to mode
    const deduped = this.dedup(filtered);
    return this.applyLaneRatios(deduped, mode);
  }

  /** Trim candidates per lane according to mode ratios. */
  private applyLaneRatios(candidates: Candidate[], mode: DiscoverMode): Candidate[] {
    const ratios = LANE_RATIOS[mode];
    const total = candidates.length;
    if (total === 0) return candidates;

    const grouped: Record<string, Candidate[]> = {};
    for (const c of candidates) {
      (grouped[c.source] ??= []).push(c);
    }

    const result: Candidate[] = [];
    for (const [source, items] of Object.entries(grouped)) {
      const ratio = ratios[source as keyof typeof ratios] ?? 0.1;
      const maxForLane = Math.max(1, Math.round(total * ratio));
      result.push(...items.slice(0, maxForLane));
    }
    return result;
  }

  private dedup(candidates: Candidate[]): Candidate[] {
    const seen = new Set<string>();
    return candidates.filter(c => {
      const key = `${c.artist.toLowerCase()}::${c.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
