# Code Standards & Conventions

## TypeScript Configuration

**Target**: ES2022 (modern Node.js 20+)
**Module System**: ESM (ES modules, Node16 resolution)
**Strict Mode**: Required (`strict: true` in tsconfig.json)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

**No CommonJS**: All imports use `import/export` syntax, never `require()`.

## Naming Conventions

### Files & Directories
- **kebab-case** for all source files: `youtube-provider.ts`, `mpv-controller.ts`
- **Descriptive names** that convey purpose for LLM tools
- **Examples**:
  - Good: `youtube-provider.ts` (describes what it provides)
  - Bad: `provider.ts` (too vague)

### Variables & Functions
- **camelCase** for variables, functions, and parameters
- **PascalCase** for classes, types, and interfaces
- **CONSTANT_CASE** for module-level constants

```typescript
// Variables & functions
const nowPlayingTrack = {...};
function getStreamUrl(videoId: string): Promise<string> {}

// Classes & types
class MpvController {}
interface Track {
  videoId: string;
  title: string;
  duration: number;
}
type SearchResult = {id: string; title: string};

// Constants
const MAX_QUEUE_SIZE = 100;
const IPC_TIMEOUT_MS = 5000;
```

## Import/Export Rules

### ESM Only
```typescript
// ✓ Correct
import { createMcpServer } from './mcp/mcp-server.js';
import type { Tool } from '@modelcontextprotocol/sdk';

// ✗ Wrong
const { createMcpServer } = require('./mcp/mcp-server');
module.exports = {...};
```

### File Extensions
Always include `.js` in ESM imports (even though source is `.ts`):
```typescript
import { getStreamUrl } from './providers/youtube-provider.js';
```

### Type Imports
Use `import type` for type-only imports to clarify intent:
```typescript
import type { Track, SearchResult } from './queue/queue-manager.js';
```

## Error Handling Pattern

**Never throw errors from MCP tool functions.** Always return a structured error response.

```typescript
// All tool functions must return this structure:
type ToolResult = {
  isError: boolean;
  message: string;
  data?: any;
};

// ✓ Correct
async function play(videoId: string): Promise<ToolResult> {
  if (!videoId) {
    return {
      isError: true,
      message: 'videoId is required'
    };
  }
  try {
    const url = await getStreamUrl(videoId);
    // ... playback logic
    return {
      isError: false,
      message: 'Playing',
      data: {nowPlaying: trackMetadata}
    };
  } catch (err) {
    return {
      isError: true,
      message: `Playback failed: ${(err as Error).message}`
    };
  }
}

// ✗ Wrong
async function play(videoId: string) {
  if (!videoId) throw new Error('videoId is required');
  const url = await getStreamUrl(videoId); // No try/catch
}
```

## Logging Rules

### stdio Safety (CRITICAL)
- **Never use `console.log()`** — corrupts MCP stdio protocol
- **Always use `console.error()`** for debug messages and logs

```typescript
// ✓ Correct
console.error('[sbotify] Starting...');
console.error('[mpv] Volume set to:', volume);

// ✗ Wrong
console.log('[sbotify] Starting...'); // Breaks MCP!
```

### Debug Format
```typescript
console.error('[module-name] message', {key: value});
// Example:
console.error('[youtube-provider] search complete', {query: 'lo-fi', results: 10});
```

## Async/Await Patterns

Always use `async/await` for Promise-based code. Never use `.then()` chains.

```typescript
// ✓ Correct
async function processTrack(videoId: string) {
  const url = await getStreamUrl(videoId);
  const metadata = await parseMetadata(videoId);
  return {url, metadata};
}

// ✗ Avoid
function processTrack(videoId: string) {
  return getStreamUrl(videoId)
    .then(url => parseMetadata(videoId).then(meta => ({url, meta})));
}
```

### Top-Level Async
```typescript
// index.ts
async function main() {
  try {
    // await async operations
  } catch (err) {
    console.error('[sbotify] Fatal error:', err);
    process.exit(1);
  }
}

main();
```

## Type Annotations

All function signatures must have explicit type annotations (strict mode enforces this).

```typescript
// ✓ Correct
async function search(query: string): Promise<SearchResult[]> {
  // ...
}

function setVolume(volume: number): void {
  // ...
}

// ✗ Wrong (relies on inference)
async function search(query) {
  // ...
}
```

## Interface & Type Definitions

Define types at module level, re-export for consumers.

```typescript
// queue-manager.ts
export interface Track {
  videoId: string;
  title: string;
  artist?: string;
  duration: number; // seconds
  url?: string;
  thumbnail?: string;
}

export type QueueState = {
  nowPlaying: Track | null;
  queue: Track[];
  history: Track[];
  pausedAt: number;
};
```

## Code Comments

### When to Comment
- **Complex logic**: Explain "why", not "what"
- **Non-obvious decisions**: Design rationale
- **Workarounds**: Temporary fixes with tracking issues

### When NOT to Comment
- Self-documenting code (good names make comments unnecessary)
- Obvious operations

```typescript
// ✓ Good
// YouTube URLs expire after ~6 hours; cache and refresh on 404
const cachedUrl = urlCache.get(videoId);
if (isUrlExpired(cachedUrl)) {
  return await getStreamUrl(videoId); // Fresh fetch
}

// ✗ Bad
// Loop through results
for (const result of results) {
  // Add to array
  items.push(result);
}
```

## File Structure

Each module should follow this pattern:

```typescript
// Imports (all at top)
import type { Tool } from '@modelcontextprotocol/sdk';
import { someFunction } from './other-module.js';

// Types & Interfaces
export interface MyType {
  // ...
}

// Constants
const DEFAULT_TIMEOUT = 5000;

// Main class/function
export class MyClass {
  // Implementation
}

// Exports (grouped at end if not inline)
export { MyClass };
```

## Zod Validation (Phase 2+)

Use Zod for MCP tool request validation:

```typescript
import { z } from 'zod';

const SearchRequestSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  limit: z.number().int().positive().optional().default(10)
});

type SearchRequest = z.infer<typeof SearchRequestSchema>;

async function search(req: SearchRequest): Promise<ToolResult> {
  const validated = SearchRequestSchema.parse(req);
  // Use validated.query, validated.limit
}
```

## Testing Standards

### Test File Naming
- Place tests adjacent to source: `foo.ts` → `foo.test.ts`
- Use descriptive test names

### Test Structure
```typescript
import { describe, it, expect } from 'vitest'; // or your framework

describe('YouTubeProvider', () => {
  describe('search', () => {
    it('should return results for valid query', async () => {
      const results = await search('lo-fi beats');
      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle empty query gracefully', async () => {
      const result = await search('');
      expect(result.isError).toBe(true);
      expect(result.message).toContain('empty');
    });
  });
});
```

### Coverage Targets
- **P0 features**: 100% coverage (search, play, skip, status)
- **P1 features**: 80% coverage (mood, queue, dashboard)
- **Helpers**: 70% coverage

## Performance Guidelines

### Target Metrics
- **Search**: < 1 second
- **Stream URL extraction**: < 2 seconds
- **Play command → audio output**: < 3 seconds
- **WebSocket update latency**: < 100ms

### Optimization Rules
1. Cache YouTube URLs (5-hour TTL)
2. Parallelize independent operations (search + metadata)
3. Use streaming for large files (mpv handles this)
4. Avoid blocking I/O in main thread

```typescript
// ✓ Parallel
const [results, metadata] = await Promise.all([
  search(query),
  parseMetadata(videoId)
]);

// ✗ Sequential
const results = await search(query);
const metadata = await parseMetadata(videoId);
```

## Security Guidelines

### Input Validation
- Validate all agent inputs (query length, IDs format)
- Sanitize WebSocket messages before broadcast
- Never execute shell commands with unsanitized input

```typescript
// ✓ Correct
const query = SearchRequestSchema.parse(input.query);

// ✗ Wrong
const cmd = `youtube-dl "${userInput}"`;
```

### Sensitive Data
- Never log credentials, API keys, or user data
- Use `console.error()` for debug (not stdout)
- No personal data in queue history

### IPC Security
- Restrict IPC socket permissions (Windows: inherited from parent)
- Validate all JSON messages from mpv

## Build & Deployment

### Compilation
```bash
npm run build    # Compiles src/ → dist/
npm run dev      # Watch mode
```

### Pre-commit Checks
- Run `tsc --noEmit` (type check)
- No unused variables or imports
- No `console.log()` calls

### npm publish
- Verify `package.json` `files` array includes `dist/` and `public/`
- Ensure shebang in dist/index.js after build
- Test `npm install -g ./` locally before publish

## Code Review Checklist

Before submitting a PR:
- [ ] TypeScript strict mode passes (`npm run build`)
- [ ] No `console.log()` (only `console.error()`)
- [ ] Error handling returns `{isError, message, data}`
- [ ] All async functions are `async/await`
- [ ] Type annotations on all function signatures
- [ ] No unused imports or variables
- [ ] Comments explain "why", not "what"
- [ ] Tests pass and cover P0 paths
- [ ] Follows file/naming conventions (kebab-case, camelCase)

## References

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Node.js ESM Docs](https://nodejs.org/api/esm.html)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Zod Documentation](https://zod.dev/)
