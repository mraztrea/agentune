// Unit tests for CandidateScorer — scoring formula and top-k sampling

import { describe, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateScorer, TEMPERATURE } from './candidate-scorer.js';
import type { Candidate } from './candidate-generator.js';
import type { TasteEngine, TasteState, AgentPersona, SessionLane } from './taste-engine.js';
import type { HistoryStore } from '../history/history-store.js';

// --- Stubs ---

function stubTaste(overrides?: Partial<TasteState>): TasteState {
  return {
    obsessions: {},
    boredom: {},
    cravings: [],
    noveltyAppetite: 0.5,
    repeatTolerance: 0.5,
    lastUpdatedAt: Date.now(),
    ...overrides,
  };
}

function stubPersona(overrides?: Partial<AgentPersona>): AgentPersona {
  return {
    curiosity: 0.4,
    dramaticTransition: 0.2,
    callbackLove: 0.5,
    antiMonotony: 0.6,
    ...overrides,
  };
}

function createMockTasteEngine(taste?: Partial<TasteState>, persona?: Partial<AgentPersona>): TasteEngine {
  return {
    getState: () => stubTaste(taste),
    getPersona: () => stubPersona(persona),
    getSessionLane: () => null,
  } as unknown as TasteEngine;
}

function createMockHistoryStore(playCountMap: Record<string, number> = {}, hoursSinceMap: Record<string, number> = {}): HistoryStore {
  return {
    getTrackPlayCount: (artist: string, title: string) => {
      const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
      return playCountMap[key] ?? 0;
    },
    hoursSinceLastPlay: (artist: string, title: string) => {
      const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
      return hoursSinceMap[key] ?? Infinity;
    },
  } as unknown as HistoryStore;
}

function makeCandidate(partial: Partial<Candidate>): Candidate {
  return {
    title: 'Test Track',
    artist: 'Test Artist',
    source: 'continuation',
    sourceDetail: 'test',
    ...partial,
  };
}

// --- Tests ---

describe('CandidateScorer.score', () => {
  test('scores produce expected relative ordering: continuation > wildcard for focus-like taste', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine({ noveltyAppetite: 0.2 }),
      createMockHistoryStore(),
    );
    const candidates: Candidate[] = [
      makeCandidate({ title: 'A', source: 'continuation', sourceDetail: 'similar' }),
      makeCandidate({ title: 'B', source: 'wildcard', sourceDetail: 'explore' }),
    ];
    const currentTrack = { artist: 'Test Artist', title: 'Current' };
    const scored = scorer.score(candidates, currentTrack);

    // Continuation has higher transition_quality (0.8 vs 0.4)
    const contScore = scored.find(s => s.title === 'A')!.score;
    const wildScore = scored.find(s => s.title === 'B')!.score;
    assert.ok(contScore > wildScore, `continuation (${contScore}) should score higher than wildcard (${wildScore})`);
  });

  test('repetition penalty reduces score for recently played tracks', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine(),
      createMockHistoryStore(
        { 'test artist::recent track': 3 },
        { 'test artist::recent track': 0.5 }, // played 30 min ago
      ),
    );
    const recent = makeCandidate({ title: 'Recent Track', artist: 'Test Artist' });
    const fresh = makeCandidate({ title: 'Fresh Track', artist: 'Test Artist' });
    const currentTrack = { artist: 'Other', title: 'Other' };

    const scored = scorer.score([recent, fresh], currentTrack);
    const recentScore = scored.find(s => s.title === 'Recent Track')!;
    const freshScore = scored.find(s => s.title === 'Fresh Track')!;

    assert.ok(freshScore.score > recentScore.score, 'fresh track should score higher than recently played');
    assert.ok(recentScore.reasons.includes('played recently'), 'should have "played recently" reason');
  });

  test('boredom penalty reduces score for overplayed artists', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine({ boredom: { 'artist:boring artist': 0.8 } }),
      createMockHistoryStore(),
    );
    const boring = makeCandidate({ title: 'Track A', artist: 'Boring Artist' });
    const fresh = makeCandidate({ title: 'Track B', artist: 'Fresh Artist' });

    const scored = scorer.score([boring, fresh], null);
    const boringScore = scored.find(s => s.artist === 'Boring Artist')!;
    const freshScore = scored.find(s => s.artist === 'Fresh Artist')!;

    assert.ok(freshScore.score > boringScore.score, 'fresh artist should score higher than boring one');
    assert.ok(boringScore.reasons.includes('getting tired of this artist'));
  });

  test('freshness bonus for never-played tracks', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine(),
      createMockHistoryStore({ 'test artist::old track': 5 }),
    );
    const neverPlayed = makeCandidate({ title: 'New Track' });
    const played = makeCandidate({ title: 'Old Track' });

    const scored = scorer.score([neverPlayed, played], null);
    const newScore = scored.find(s => s.title === 'New Track')!;
    assert.ok(newScore.reasons.includes('new discovery'));
  });

  test('obsession boost increases score for obsessed artists', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine({ obsessions: { 'artist:loved artist': 0.9 } }),
      createMockHistoryStore(),
    );
    const loved = makeCandidate({ title: 'Track', artist: 'Loved Artist' });
    const neutral = makeCandidate({ title: 'Track', artist: 'Neutral Artist' });

    const scored = scorer.score([loved, neutral], null);
    const lovedScore = scored.find(s => s.artist === 'Loved Artist')!;
    const neutralScore = scored.find(s => s.artist === 'Neutral Artist')!;

    assert.ok(lovedScore.score > neutralScore.score, 'obsessed artist should score higher');
    assert.ok(lovedScore.reasons.includes('matches taste'));
  });
});

describe('CandidateScorer.topKSample', () => {
  test('temperature=0 returns deterministic top-k', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine(),
      createMockHistoryStore(),
    );
    const scored = [
      { ...makeCandidate({ title: 'A' }), score: 0.9, reasons: [] },
      { ...makeCandidate({ title: 'B' }), score: 0.7, reasons: [] },
      { ...makeCandidate({ title: 'C' }), score: 0.5, reasons: [] },
      { ...makeCandidate({ title: 'D' }), score: 0.3, reasons: [] },
      { ...makeCandidate({ title: 'E' }), score: 0.1, reasons: [] },
    ];

    const result = scorer.topKSample(scored, 3, 0.05);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'A');
    assert.equal(result[1].title, 'B');
    assert.equal(result[2].title, 'C');
  });

  test('returns empty array for empty input', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine(),
      createMockHistoryStore(),
    );
    const result = scorer.topKSample([], 5, 0.7);
    assert.equal(result.length, 0);
  });

  test('returns all items when pool smaller than k (deterministic)', () => {
    const scorer = new CandidateScorer(
      createMockTasteEngine(),
      createMockHistoryStore(),
    );
    const scored = [
      { ...makeCandidate({ title: 'A' }), score: 0.9, reasons: [] },
      { ...makeCandidate({ title: 'B' }), score: 0.7, reasons: [] },
    ];

    // Use near-zero temperature for deterministic path
    const result = scorer.topKSample(scored, 5, 0.05);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'A');
    assert.equal(result[1].title, 'B');
  });

  test('TEMPERATURE constants are defined', () => {
    assert.equal(TEMPERATURE.focus, 0.3);
    assert.equal(TEMPERATURE.balanced, 0.7);
    assert.equal(TEMPERATURE.explore, 1.2);
  });
});
