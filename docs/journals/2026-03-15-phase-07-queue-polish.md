# Phase 7 Queue Loop Closed

**Date**: 2026-03-15 13:55
**Severity**: Medium
**Component**: Queue playback / release prep
**Status**: Resolved

## What Happened

Phase 7 started with the most annoying kind of unfinished work: queue tools existed in the MCP surface, but they did not really do queue work. `queue_add`, `queue_list`, and `skip` were basically promises without a real playback loop behind them. The browser dashboard also still showed placeholder queue data, which meant the UI implied completeness that the backend had not earned.

## The Brutal Truth

This was the last fake-looking part of the MVP. Everything around it already looked real enough that the stubbed queue path was becoming a credibility problem. A music server without a working queue is half a toy. The painful part is that playback state was split across MCP handlers, mpv, and dashboard state, so a naive fix would have duplicated logic and produced racey behavior the moment manual skip and natural track end collided.

## Technical Details

- Added `src/queue/queue-manager.ts` for `nowPlaying`, `queue`, and `history`
- Added `src/queue/queue-playback-controller.ts` to centralize `playById()`, `queueByQuery()`, and `skip()`
- Hooked mpv stop lifecycle into queue auto-advance
- Updated dashboard state to use real queue snapshots
- Added Node tests:
  - `src/queue/queue-manager.test.ts`
  - `src/queue/queue-playback-controller.test.ts`
- Validation passed:
  - `npm run build`
  - `npm test`

## What We Tried

- First approach was to keep queue mutations inside MCP handlers. Rejected because it would drift from natural mpv track-end behavior.
- Then we checked `node-mpv` event behavior and used that to wire a single queue playback controller around mpv stop events.
- Added a manual-skip guard so stop events from skip would not double-advance the queue.

## Root Cause Analysis

The root problem was architectural incompleteness, not a single bug. Queue state existed conceptually, but there was no single owner for playback transitions. Without that owner, each feature path would keep reimplementing “what happens next?” slightly differently.

## Lessons Learned

- If playback can advance from more than one trigger, one module must own the transition logic.
- Dashboard placeholders become liabilities fast once surrounding features are real.
- Release prep and feature completion are not the same thing; publishing should stay a separate explicit step.

## Next Steps

- Run publish-readiness checks: `npm install -g ./` and `npm publish --dry-run`
- Verify queue behavior on macOS/Linux hosts
- Publish only after explicit release approval
