// 4-lane candidate generation for discover pipeline
// Apple Search API is the primary catalog backbone; Smart Search is query-expansion fallback only.

import type { SmartSearchProvider } from '../providers/smart-search-provider.js';
import type { AppleSearchProvider } from '../providers/apple-search-provider.js';
import type { HistoryStore } from '../history/history-store.js';
import type { TasteEngine, TrackInfo } from './taste-engine.js';

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
    private readonly smartSearch: SmartSearchProvider | null,
    private readonly apple: AppleSearchProvider | null,
    private readonly historyStore: HistoryStore,
    private readonly tasteEngine: TasteEngine,
  ) {}

  async generate(
    currentTrack: TrackInfo | null,
    intent?: MusicIntent,
    mode: DiscoverMode = 'balanced',
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const topPlayed = this.historyStore.getTopTracks(6);
    const sessionLane = this.tasteEngine.getSessionLane();

    // Lane A: Continuation — Apple artist catalog first, Smart Search as fallback
    if (currentTrack && this.apple) {
      try {
        const artistTracks = await this.apple.getArtistTracks(currentTrack.artist, 8);
        for (const track of artistTracks) {
          if (
            track.artist.toLowerCase() === currentTrack.artist.toLowerCase() &&
            track.title.toLowerCase() === currentTrack.title.toLowerCase()
          ) {
            continue;
          }
          candidates.push({
            title: track.title, artist: track.artist,
            source: 'continuation',
            sourceDetail: `same artist as ${currentTrack.artist}`,
          });
        }
      } catch (err) {
        console.error('[sbotify] Lane A (continuation) failed:', (err as Error).message);
      }
    }

    if (currentTrack && this.smartSearch) {
      try {
        const related = await this.smartSearch.getRelatedTracks(currentTrack.artist, currentTrack.title, 4);
        for (const track of related) {
          candidates.push({
            title: track.title,
            artist: track.artist,
            source: 'continuation',
            sourceDetail: `expanded from ${currentTrack.artist}`,
          });
        }
      } catch (err) {
        console.error('[sbotify] Lane A fallback (continuation) failed:', (err as Error).message);
      }
    }

    // Lane B: Comfort — most-played tracks from local history
    for (const track of topPlayed) {
      candidates.push({
        title: track.title,
        artist: track.artist,
        source: 'comfort',
        sourceDetail: `played ${track.play_count} times`,
      });
    }

    // Lane C: Context Fit — Apple genre/catalog search first, Smart Search only if Apple is too thin
    const contextTags = intent?.allowed_tags ?? sessionLane?.tags ?? [];
    if (contextTags.length > 0 && (this.apple || this.smartSearch)) {
      const selectedTags = contextTags.slice(0, 2);
      for (const tag of selectedTags) {
        try {
          let contextCount = 0;
          if (this.apple) {
            const genreTracks = await this.apple.searchByGenre(tag, 4);
            for (const track of genreTracks) {
              candidates.push({
                title: track.title,
                artist: track.artist,
                source: 'context_fit',
                sourceDetail: `matches genre: ${tag}`,
                tags: [tag],
              });
              contextCount += 1;
            }

            if (contextCount < 2) {
              const searchTracks = await this.apple.searchTracks(`${tag} instrumental`, 3);
              for (const track of searchTracks) {
                candidates.push({
                  title: track.title,
                  artist: track.artist,
                  source: 'context_fit',
                  sourceDetail: `matches lane query: ${tag}`,
                  tags: [tag],
                });
                contextCount += 1;
              }
            }
          }

          if (contextCount < 2 && this.smartSearch) {
            const moodTracks = await this.smartSearch.searchByMood(tag, 2);
            for (const track of moodTracks) {
              candidates.push({
                title: track.title,
                artist: track.artist,
                source: 'context_fit',
                sourceDetail: `expanded from tag: ${tag}`,
                tags: [tag],
              });
            }
          }
        } catch (err) {
          console.error(`[sbotify] Lane C (context_fit) tag "${tag}" failed:`, (err as Error).message);
        }
      }
    }

    // Lane D: Wildcard — Smart Search suggests artists; Apple supplies clean catalog tracks
    if (currentTrack && this.smartSearch) {
      try {
        const suggestedArtists = await this.smartSearch.getArtistSuggestions(currentTrack.artist, 3);
        if (suggestedArtists.length > 0) {
          const pick = suggestedArtists[Math.floor(Math.random() * suggestedArtists.length)];
          if (this.apple) {
            const artistTracks = await this.apple.getArtistTracks(pick, 3);
            for (const track of artistTracks) {
              candidates.push({
                title: track.title,
                artist: track.artist,
                source: 'wildcard',
                sourceDetail: `exploring via ${pick}`,
              });
            }
          } else {
            const artistTracks = await this.smartSearch.getRelatedTracks(pick, pick, 2);
            for (const track of artistTracks) {
              candidates.push({
                title: track.title,
                artist: track.artist,
                source: 'wildcard',
                sourceDetail: `expanded via ${pick}`,
              });
            }
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
