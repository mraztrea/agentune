import type { HistoryStore } from '../history/history-store.js';
import type { TasteEngine } from './taste-engine.js';
import type { DiscoverCandidate, DiscoverBatchParams } from './discover-batch-builder.js';
import { DiscoverBatchBuilder } from './discover-batch-builder.js';
import type { DiscoverPaginationCache } from './discover-pagination-cache.js';
import { getDiscoverPaginationCache } from './discover-pagination-cache.js';
import { mergeAndDedup } from './discover-merge-and-dedup.js';
import { rankCandidates } from './discover-soft-ranker.js';

export interface DiscoverRequest extends DiscoverBatchParams {
  page?: number;
  limit?: number;
  mode?: unknown;
  intent?: unknown;
}

export interface PublicDiscoverCandidate {
  title: string;
  artist: string;
  tags: string[];
  provider: 'apple';
}

export interface DiscoverResponse {
  page: number;
  limit: number;
  hasMore: boolean;
  candidates: PublicDiscoverCandidate[];
  emptyReason?: 'no_candidates' | 'page_exhausted';
}

export class DiscoverPipeline {
  constructor(
    private readonly batchBuilder: DiscoverBatchBuilder,
    private readonly store: Pick<HistoryStore, 'getTopArtists' | 'getTopTags' | 'getRecentPlaysDetailed' | 'batchGetTrackStats'>,
    private readonly tasteEngine: Pick<TasteEngine, 'getTraits'>,
    private readonly cache: DiscoverPaginationCache,
  ) {}

  async discover(params: DiscoverRequest): Promise<DiscoverResponse> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const cacheParams = { artist: params.artist, genres: params.genres };

    const cachedPage = this.cache.getPage(cacheParams, page, limit);
    if (cachedPage) {
      return buildDiscoverResponse(
        cachedPage.candidates,
        page,
        limit,
        cachedPage.hasMore,
        cachedPage.candidates.length === 0 ? 'page_exhausted' : undefined,
      );
    }

    const rawCandidates = await this.batchBuilder.buildBatches(cacheParams);
    if (rawCandidates.length === 0) {
      return buildDiscoverResponse([], page, limit, false, 'no_candidates');
    }

    const dedupedCandidates = mergeAndDedup(rawCandidates);
    const rankedCandidates = rankCandidates(dedupedCandidates, this.tasteEngine.getTraits(), this.store);
    this.cache.setSnapshot(cacheParams, rankedCandidates);

    const pagedCandidates = this.cache.getPage(cacheParams, page, limit);
    if (pagedCandidates) {
      return buildDiscoverResponse(
        pagedCandidates.candidates,
        page,
        limit,
        pagedCandidates.hasMore,
        pagedCandidates.candidates.length === 0 ? 'page_exhausted' : undefined,
      );
    }

    const candidates = rankedCandidates.slice((page - 1) * limit, page * limit);
    return buildDiscoverResponse(
      candidates,
      page,
      limit,
      page * limit < rankedCandidates.length,
      candidates.length === 0 ? 'page_exhausted' : undefined,
    );
  }
}

function buildDiscoverResponse(
  candidates: DiscoverCandidate[],
  page: number,
  limit: number,
  hasMore: boolean,
  emptyReason?: 'no_candidates' | 'page_exhausted',
): DiscoverResponse {
  return {
    page,
    limit,
    hasMore,
    candidates: candidates.map((candidate) => toPublicCandidate(candidate)),
    emptyReason,
  };
}

function toPublicCandidate(candidate: DiscoverCandidate): PublicDiscoverCandidate {
  return {
    title: candidate.title,
    artist: candidate.artist,
    tags: candidate.tags,
    provider: candidate.provider,
  };
}

let discoverPipeline: DiscoverPipeline | null = null;

export function createDiscoverPipeline(
  batchBuilder: DiscoverBatchBuilder,
  store: Pick<HistoryStore, 'getTopArtists' | 'getTopTags' | 'getRecentPlaysDetailed' | 'batchGetTrackStats'>,
  tasteEngine: Pick<TasteEngine, 'getTraits'>,
  cache = getDiscoverPaginationCache(),
): DiscoverPipeline {
  if (!discoverPipeline) {
    discoverPipeline = new DiscoverPipeline(batchBuilder, store, tasteEngine, cache);
  }
  return discoverPipeline;
}

export function getDiscoverPipeline(): DiscoverPipeline | null {
  return discoverPipeline;
}
