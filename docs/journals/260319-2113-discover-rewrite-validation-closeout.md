# Discover Rewrite Closed Out, But Validation Still Drew Blood

**Date**: 2026-03-19 21:13
**Severity**: Medium
**Component**: Discover pipeline / validation
**Status**: Resolved

## What Happened

The flat Apple-only discover rewrite is effectively done. The grouped-lane flow is gone, the public MCP contract is now `discover(page?, limit?, artist?, genres?)`, cache invalidation is wired to `play_song()` and `add_song()`, and automated validation ended green. Final recorded state: `npm run build` passed, `npm test` passed with 93/93, and the built handler smoke returned a valid Apple candidate for `handleDiscover({ artist: 'Nils Frahm', limit: 1 })`.

## The Brutal Truth

This did not finish as cleanly as the final green test count makes it look. Validation exposed a real ranking bug first, then the test harness made the situation noisier than it needed to be. The frustrating part is that the rewrite itself was mostly right, but one ranker assertion proved the exploration path was still too weak, and Windows temp DB cleanup piled on after the failure. Classic last-mile mess: the signal was real, the noise was avoidable, and both had to be dealt with before the session could honestly be called done.

## Technical Details

The concrete failure was the exploration-heavy ranker test: novel artists were not consistently beating familiar ones when `exploration` was high. After that assertion failed, temp DB cleanup could also blow up because the SQLite file handle sometimes lingered long enough for `rmSync(...)` to complain on Windows. The fix landed in two parts: tighten the ranker behavior so the exploration case orders correctly, and harden test cleanup so a lingering handle does not mask the real failure. Result now matches the intended contract: ranker tests green, pipeline tests green, full suite green.

## What We Tried

Adjusted ranker behavior to preserve exploration wins. Kept explicit `store.close()` in test teardown. Made cleanup tolerant of post-assertion Windows handle lag instead of letting teardown noise overshadow the actual bug.

## Root Cause Analysis

Two separate problems surfaced together. The first was legitimate scoring behavior: the soft ranker still underweighted novelty in the exploration-heavy path. The second was test hygiene: cleanup assumed the filesystem would be immediately ready after failure, which is not a safe assumption with SQLite on Windows.

## Lessons Learned

Green-at-the-end is not the same as clean-throughout. Ranker behavior needs explicit tests for trait extremes, and teardown code should never be allowed to hide the original failure.

## Next Steps

Only one follow-up remains: record a full daemon/MCP smoke run. Everything else for the discover rewrite is landed and validated.

**Status:** DONE_WITH_CONCERNS
**Summary:** Flat Apple-only discover rewrite shipped with the main fixes landed; build, ranker coverage, pipeline coverage, and the full test suite are green.
**Concerns/Blockers:** Full daemon/MCP smoke validation is still not recorded.
