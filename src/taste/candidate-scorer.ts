// Candidate scoring formula (8 weighted terms) + top-k softmax sampling
// Used by discover pipeline to rank and sample from candidates

import type { TasteEngine, TrackInfo } from './taste-engine.js';
import type { HistoryStore } from '../history/history-store.js';
import type { Candidate, MusicIntent } from './candidate-generator.js';

export interface ScoredCandidate extends Candidate {
  score: number;
  reasons: string[];
}

export const TEMPERATURE = { focus: 0.3, balanced: 0.7, explore: 1.2 } as const;

export class CandidateScorer {
  constructor(
    private readonly tasteEngine: TasteEngine,
    private readonly historyStore: HistoryStore,
  ) {}

  score(candidates: Candidate[], currentTrack: TrackInfo | null, intent?: MusicIntent): ScoredCandidate[] {
    return candidates.map(c => this.scoreOne(c, currentTrack, intent));
  }

  private scoreOne(candidate: Candidate, currentTrack: TrackInfo | null, intent?: MusicIntent): ScoredCandidate {
    const taste = this.tasteEngine.getState();
    const persona = this.tasteEngine.getPersona();
    const reasons: string[] = [];
    let score = 0;

    // +0.32 context_match — fits intent/session?
    const contextScore = this.contextMatch(candidate, intent);
    score += 0.32 * contextScore;
    if (contextScore > 0.5) reasons.push('fits current vibe');

    // +0.24 taste_match — aligned with obsessions?
    const artistKey = `artist:${candidate.artist.toLowerCase()}`;
    const tasteScore = taste.obsessions[artistKey] ?? 0;
    score += 0.24 * tasteScore;
    if (tasteScore > 0.3) reasons.push('matches taste');

    // +0.18 transition_quality — smooth from current track?
    const transitionScore = currentTrack
      ? (candidate.source === 'continuation' ? 0.8 : 0.4)
      : 0.5;
    score += 0.18 * transitionScore;

    // +0.10 familiarity_fit — aligns with repeat tolerance + callback love
    const playCount = this.historyStore.getTrackPlayCount(candidate.artist, candidate.title);
    const familiarityScore = playCount > 0
      ? taste.repeatTolerance * persona.callbackLove
      : 0;
    score += 0.10 * familiarityScore;
    if (playCount > 0 && familiarityScore > 0.3) reasons.push('familiar favorite');

    // +0.08 exploration_bonus — novelty appetite + persona curiosity
    const explorationScore = candidate.source === 'wildcard'
      ? taste.noveltyAppetite * persona.curiosity
      : (playCount === 0 ? 0.5 * taste.noveltyAppetite : 0);
    score += 0.08 * explorationScore;
    if (playCount === 0) reasons.push('new discovery');

    // +0.08 freshness_bonus — never played = fresh
    const freshnessScore = playCount === 0 ? 1.0 : 1.0 / (1 + playCount);
    score += 0.08 * freshnessScore;

    // -0.22 repetition_penalty — recently played, scaled by antiMonotony
    const hoursSince = this.historyStore.hoursSinceLastPlay(candidate.artist, candidate.title);
    const repetitionPenalty = hoursSince !== null && isFinite(hoursSince) && hoursSince < 2
      ? 0.8 * persona.antiMonotony
      : 0;
    score -= 0.22 * repetitionPenalty;
    if (repetitionPenalty > 0) reasons.push('played recently');

    // -0.18 boredom_penalty — from taste state
    const boredomScore = taste.boredom[artistKey] ?? 0;
    score -= 0.18 * boredomScore;
    if (boredomScore > 0.3) reasons.push('getting tired of this artist');

    return { ...candidate, score: Math.round(Math.max(0, score) * 1000) / 1000, reasons };
  }

  /** Context match: how well candidate fits the music intent or session lane. */
  private contextMatch(candidate: Candidate, intent?: MusicIntent): number {
    if (!intent) {
      // No intent — source-based heuristic
      return candidate.source === 'context_fit' ? 0.7 : candidate.source === 'continuation' ? 0.6 : 0.3;
    }
    let match = 0.3; // base
    // Tag match
    if (intent.allowed_tags && candidate.tags) {
      const intentSet = new Set(intent.allowed_tags.map(t => t.toLowerCase()));
      const tagHits = candidate.tags.filter(t => intentSet.has(t.toLowerCase())).length;
      match += tagHits > 0 ? 0.4 : 0;
    }
    // Novelty alignment: wildcard candidates match high novelty intent
    if (intent.novelty !== undefined && intent.novelty > 0.6 && candidate.source === 'wildcard') {
      match += 0.2;
    }
    if (intent.novelty !== undefined && intent.novelty < 0.3 && candidate.source === 'comfort') {
      match += 0.2;
    }
    return Math.min(1, match);
  }

  /** Top-k sampling with softmax temperature. Low temp = deterministic, high = exploratory. */
  topKSample(scored: ScoredCandidate[], k = 5, temperature = 0.7): ScoredCandidate[] {
    if (scored.length === 0) return [];

    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const pool = sorted.slice(0, Math.min(k * 2, sorted.length));

    if (temperature <= 0.1) return pool.slice(0, k);

    // Softmax sampling with temperature
    const weights = pool.map(c => Math.exp(c.score / temperature));
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const selected: ScoredCandidate[] = [];
    const available = [...pool];
    const availableWeights = weights.map(w => w / totalWeight);

    for (let i = 0; i < Math.min(k, available.length); i++) {
      const r = Math.random();
      let cumulative = 0;
      let picked = false;
      for (let j = 0; j < available.length; j++) {
        cumulative += availableWeights[j];
        if (r <= cumulative) {
          selected.push(available[j]);
          available.splice(j, 1);
          availableWeights.splice(j, 1);
          picked = true;
          break;
        }
      }
      // Fallback: floating-point rounding — pick last item
      if (!picked && available.length > 0) {
        const last = available.length - 1;
        selected.push(available[last]);
        available.splice(last, 1);
        availableWeights.splice(last, 1);
      }
      // Renormalize remaining weights
      const newTotal = availableWeights.reduce((a, b) => a + b, 0);
      if (newTotal > 0) {
        for (let m = 0; m < availableWeights.length; m++) {
          availableWeights[m] /= newTotal;
        }
      }
    }
    return selected;
  }
}
