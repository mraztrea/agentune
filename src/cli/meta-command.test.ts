import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypointPath = fileURLToPath(new URL('../index.js', import.meta.url));
const packageJsonPath = new URL('../../package.json', import.meta.url);
const packageMetadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  description: string;
  version: string;
};

test('agentune --version prints package version and exits cleanly', () => {
  const result = spawnSync(process.execPath, [entrypointPath, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), packageMetadata.version);
});

test('agentune --help prints CLI usage and exits cleanly', () => {
  const result = spawnSync(process.execPath, [entrypointPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^agentune/m);
  assert.match(result.stdout, new RegExp(packageMetadata.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stdout, /agentune --version/);
  assert.match(result.stdout, /agentune start/);
});
