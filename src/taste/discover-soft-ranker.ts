import type { BatchTrackStats, HistoryStore } from '../history/history-store.js';
import { normalizeTrackId } from '../history/history-schema.js';
import type { PersonaTraits } from './taste-engine.js';
import type { DiscoverCandidate } from './discover-batch-builder.js';

export interface RankingContext {
  topArtists: Map<string, number>;
  topTags: Set<string>;
  maxArtistPlays: number;
  hasSparseHistory: boolean;
}

interface ScoredCandidate {
  candidate: DiscoverCandidate;
  index: number;
  score: number;
}

const DEFAULT_COMPLETION_AFFINITY = 0.5;
const MIN_HISTORY_FOR_FULL_SCORING = 10;

export function buildRankingContext(
  store: Pick<HistoryStore, 'getTopArtists' | 'getTopTags' | 'getRecentPlaysDetailed'>,
): RankingContext {
  const topArtists = new Map(store.getTopArtists(200).map((artist) => [normalizeValue(artist.artist), artist.plays]));
  const topTags = new Set(store.getTopTags(20).map((tag) => normalizeValue(tag.tag)));
  const maxArtistPlays = Math.max(1, ...topArtists.values());
  const hasSparseHistory = store.getRecentPlaysDetailed(MIN_HISTORY_FOR_FULL_SCORING).length < MIN_HISTORY_FOR_FULL_SCORING;

  return { topArtists, topTags, maxArtistPlays, hasSparseHistory };
}

export function rankCandidates(
  candidates: DiscoverCandidate[],
  traits: PersonaTraits,
  store: Pick<HistoryStore, 'getTopArtists' | 'getTopTags' | 'getRecentPlaysDetailed' | 'batchGetTrackStats'>,
): DiscoverCandidate[] {
  const rankingContext = buildRankingContext(store);
  const trackStats = loadTrackStats(store, candidates);

  const scoredCandidates: ScoredCandidate[] = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: scoreCandidate(candidate, traits, rankingContext, trackStats),
  }));

  scoredCandidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const varietyAdjustedCandidates = applyVarietyDiversityPass(scoredCandidates, traits.variety);
  return breakArtistClusters(varietyAdjustedCandidates.map((entry) => entry.candidate));
}

function loadTrackStats(
  store: Pick<HistoryStore, 'batchGetTrackStats'>,
  candidates: DiscoverCandidate[],
): Map<string, BatchTrackStats> {
  const trackIds = candidates.map((candidate) => normalizeTrackId(candidate.artist, candidate.title));
  return store.batchGetTrackStats(trackIds);
}

function scoreCandidate(
  candidate: DiscoverCandidate,
  traits: PersonaTraits,
  rankingContext: RankingContext,
  trackStats: Map<string, BatchTrackStats>,
): number {
  const artistFamiliarity = computeArtistFamiliarity(candidate.artist, rankingContext);
  const stats = getTrackStats(candidate, trackStats);
  const tagAffinity = computeTagAffinity(candidate.tags, rankingContext.topTags);
  const novelty = 1 - artistFamiliarity;
  const recentRepeatPenalty = computeRecentRepeatPenalty(stats.hoursSinceLastPlay);
  const loyaltyMod = 0.5 + 0.5 * traits.loyalty;
  const explorationMod = 0.5 + 0.5 * traits.exploration;

  if (rankingContext.hasSparseHistory) {
    return clamp(
      0.8 * tagAffinity +
      0.1 * stats.avgCompletion -
      0.1 * recentRepeatPenalty -
      0.1 * stats.skipRate,
    );
  }

  const raw =
    0.45 * tagAffinity +
    0.20 * (loyaltyMod * artistFamiliarity) +
    0.15 * (loyaltyMod * stats.avgCompletion) +
    0.20 * (explorationMod * novelty) -
    0.15 * recentRepeatPenalty -
    0.15 * stats.skipRate;

  return clamp(raw);
}

function computeTagAffinity(candidateTags: string[], topTags: Set<string>): number {
  if (candidateTags.length === 0) return DEFAULT_COMPLETION_AFFINITY;
  const normalizedTags = [...new Set(candidateTags.map((tag) => normalizeValue(tag)).filter(Boolean))];
  if (normalizedTags.length === 0) return DEFAULT_COMPLETION_AFFINITY;

  const matches = normalizedTags.filter((tag) => topTags.has(tag)).length;
  return clamp(matches / normalizedTags.length);
}

function computeArtistFamiliarity(artist: string, rankingContext: RankingContext): number {
  const plays = rankingContext.topArtists.get(normalizeValue(artist)) ?? 0;
  return clamp(plays / rankingContext.maxArtistPlays);
}

function computeRecentRepeatPenalty(hoursSinceLastPlay: number): number {
  if (!Number.isFinite(hoursSinceLastPlay)) return 0;
  if (hoursSinceLastPlay < 1) return 1;
  if (hoursSinceLastPlay < 24) return clamp(1 - (hoursSinceLastPlay / 24));
  return 0;
}

function getTrackStats(
  candidate: DiscoverCandidate,
  trackStats: Map<string, BatchTrackStats>,
): BatchTrackStats {
  const trackId = normalizeTrackId(candidate.artist, candidate.title);
  const stats = trackStats.get(trackId);
  if (!stats || stats.playCount === 0) {
    return {
      trackId,
      playCount: 0,
      avgCompletion: DEFAULT_COMPLETION_AFFINITY,
      skipRate: 0,
      hoursSinceLastPlay: Infinity,
    };
  }

  return {
    ...stats,
    avgCompletion: clamp(stats.avgCompletion),
    skipRate: clamp(stats.skipRate),
  };
}

function applyVarietyDiversityPass(
  scoredCandidates: ScoredCandidate[],
  variety: number,
): ScoredCandidate[] {
  const lookahead = getVarietyLookahead(variety);
  if (lookahead <= 1 || scoredCandidates.length <= 2) {
    return [...scoredCandidates];
  }

  const ordered: ScoredCandidate[] = [];
  const remaining = [...scoredCandidates];

  while (remaining.length > 0) {
    const recentCandidates = ordered.slice(-2).map((entry) => entry.candidate);
    const scanLimit = Math.min(remaining.length, lookahead);
    let bestIndex = 0;
    let bestAdjustedScore = getVarietyAdjustedScore(remaining[0], recentCandidates, variety);

    for (let index = 1; index < scanLimit; index += 1) {
      const adjustedScore = getVarietyAdjustedScore(remaining[index], recentCandidates, variety);
      if (adjustedScore > bestAdjustedScore) {
        bestIndex = index;
        bestAdjustedScore = adjustedScore;
      }
    }

    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
}

function getVarietyLookahead(variety: number): number {
  if (variety < 0.34) return 1;
  if (variety < 0.67) return 3;
  return 5;
}

function getVarietyAdjustedScore(
  entry: ScoredCandidate,
  recentCandidates: DiscoverCandidate[],
  variety: number,
): number {
  return entry.score - (computeVarietyPenalty(entry.candidate, recentCandidates) * variety * 0.14);
}

function computeVarietyPenalty(
  candidate: DiscoverCandidate,
  recentCandidates: DiscoverCandidate[],
): number {
  if (recentCandidates.length === 0) return 0;

  let penalty = 0;
  const normalizedArtist = normalizeValue(candidate.artist);
  const recentArtists = new Set(recentCandidates.map((recentCandidate) => normalizeValue(recentCandidate.artist)));
  if (recentArtists.has(normalizedArtist)) {
    penalty += 1;
  }

  const normalizedTags = [...new Set(candidate.tags.map((tag) => normalizeValue(tag)).filter(Boolean))];
  if (normalizedTags.length === 0) {
    return penalty;
  }

  const recentTags = new Set(
    recentCandidates.flatMap((recentCandidate) => recentCandidate.tags.map((tag) => normalizeValue(tag)).filter(Boolean)),
  );
  const overlappingTags = normalizedTags.filter((tag) => recentTags.has(tag)).length;
  return penalty + (overlappingTags / normalizedTags.length);
}

function breakArtistClusters(candidates: DiscoverCandidate[]): DiscoverCandidate[] {
  const ranked = [...candidates];

  for (let index = 1; index < ranked.length; index += 1) {
    if (normalizeValue(ranked[index - 1].artist) !== normalizeValue(ranked[index].artist)) continue;

    const swapIndex = findNextDifferentArtist(ranked, index);
    if (swapIndex === -1) continue;
    [ranked[index], ranked[swapIndex]] = [ranked[swapIndex], ranked[index]];
  }

  return ranked;
}

function findNextDifferentArtist(candidates: DiscoverCandidate[], fromIndex: number): number {
  const artist = normalizeValue(candidates[fromIndex].artist);
  for (let index = fromIndex + 1; index < candidates.length; index += 1) {
    if (normalizeValue(candidates[index].artist) !== artist) {
      return index;
    }
  }
  return -1;
}

function normalizeValue(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
