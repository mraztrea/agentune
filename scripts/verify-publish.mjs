import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { NPM, ROOT_DIR, ensure, parseJsonOutput, readPackageJson, removeDir, run, runResult, runText } from './publish-utils.mjs';

const PACKAGE_NAME = 'agentune';
const BIN_PATH = 'dist/index.js';
const REPOSITORY_URL = 'git+https://github.com/tqdat410/agentune.git';
const HOMEPAGE_URL = 'https://github.com/tqdat410/agentune#readme';
const BUGS_URL = 'https://github.com/tqdat410/agentune/issues';
const ALLOWED_ROOT_FILES = new Set(['README.md', 'LICENSE', 'package.json']);
const ALLOWED_INSTALL_DEPRECATION_WARNINGS = [
  /npm warn deprecated prebuild-install@/iu,
];

function validateMetadata(pkg) {
  ensure(pkg.name === PACKAGE_NAME, `package.json name must be "${PACKAGE_NAME}".`);
  ensure(!('main' in pkg), 'CLI-only package must not declare a "main" entry.');
  ensure(pkg.type === 'module', 'package.json type must stay "module".');
  ensure(pkg.bin?.agentune === BIN_PATH, `package.json bin.agentune must be "${BIN_PATH}".`);
  ensure(pkg.engines?.node === '>=20', 'package.json engines.node must be ">=20".');
  ensure(pkg.publishConfig?.access === 'public', 'package.json publishConfig.access must be "public".');
  ensure(pkg.repository?.url === REPOSITORY_URL, 'package.json repository.url must point at the GitHub repo.');
  ensure(pkg.homepage === HOMEPAGE_URL, 'package.json homepage must point at the repo README.');
  ensure(pkg.bugs?.url === BUGS_URL, 'package.json bugs.url must point at the repo issues page.');
  ensure(pkg.license === 'MIT', 'package.json license must stay "MIT".');
}

function validatePackedFiles(files) {
  const violations = [];

  for (const file of files) {
    const normalizedPath = String(file.path).replace(/\\/g, '/');
    const allowedRootFile = ALLOWED_ROOT_FILES.has(normalizedPath);
    const allowedPrefix = normalizedPath.startsWith('dist/') || normalizedPath.startsWith('public/');

    if (!allowedRootFile && !allowedPrefix) {
      violations.push(`${normalizedPath} (unexpected file outside CLI runtime surface)`);
      continue;
    }

    if (normalizedPath.endsWith('.map')) {
      violations.push(`${normalizedPath} (sourcemap)`);
    }

    if (/\.test\.(js|d\.ts)$/u.test(normalizedPath)) {
      violations.push(`${normalizedPath} (compiled test file)`);
    }

    if (/test-helper/i.test(normalizedPath)) {
      violations.push(`${normalizedPath} (test helper)`);
    }
  }

  ensure(violations.length === 0, `Tarball contains non-runtime files:\n- ${violations.join('\n- ')}`);
}

function verifyInstalledTarball(tarballPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentune-publish-'));
  const installDir = path.join(tempRoot, 'install');
  const dataDir = path.join(tempRoot, 'data');

  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    run(NPM, ['init', '-y'], { cwd: installDir });
    const installResult = runResult(NPM, ['install', tarballPath], { cwd: installDir });
    const installOutput = `${installResult.stdout ?? ''}\n${installResult.stderr ?? ''}`.trim();

    if (installOutput) {
      console.error(installOutput);
    }

    ensure(
      installResult.status === 0,
      `Tarball install failed:\n${installOutput || '(no output)'}`,
    );
    assertExpectedInstallWarningsOnly(installOutput);

    const env = { AGENTUNE_DATA_DIR: dataDir };
    const installedEntry = path.join(installDir, 'node_modules', PACKAGE_NAME, BIN_PATH);
    const cliResult = runResult(process.execPath, [installedEntry, 'status'], {
      cwd: installDir,
      env,
      timeout: 5000,
    });
    const cliOutput = `${cliResult.stdout ?? ''}\n${cliResult.stderr ?? ''}`;

    ensure(
      cliResult.status === 1 && cliOutput.includes('Daemon is not running'),
      `Installed CLI smoke test failed:\n${cliOutput.trim() || '(no output)'}`,
    );

    const importScript = [
      `import('${PACKAGE_NAME}')`,
      '.then(() => {',
      "  console.error('Programmatic import unexpectedly succeeded');",
      '  process.exit(2);',
      '})',
      '.catch(() => process.exit(0));',
    ].join('');
    const importResult = runResult(process.execPath, ['-e', importScript], {
      cwd: installDir,
      env,
      timeout: 5000,
    });

    ensure(importResult.status === 0, 'Installed package unexpectedly exposed a root import entry.');
  } finally {
    removeDir(tempRoot);
  }
}

function assertExpectedInstallWarningsOnly(output) {
  const deprecationWarnings = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^npm warn deprecated /iu.test(line));

  const unexpectedWarnings = deprecationWarnings.filter((line) => {
    return !ALLOWED_INSTALL_DEPRECATION_WARNINGS.some((pattern) => pattern.test(line));
  });

  ensure(
    unexpectedWarnings.length === 0,
    `Unexpected install deprecation warnings:\n${unexpectedWarnings.join('\n')}`,
  );
}

console.error('[agentune] Verifying publish metadata...');
const pkg = readPackageJson();
validateMetadata(pkg);
ensure(fs.existsSync(path.join(ROOT_DIR, 'LICENSE')), 'LICENSE file is required before publish.');

console.error('[agentune] Running build + test gate...');
run(NPM, ['test']);

console.error('[agentune] Inspecting packed contents...');
const dryRunOutput = runText(NPM, ['pack', '--json', '--dry-run']);
const dryRunEntries = parseJsonOutput(dryRunOutput);
const dryRunEntry = Array.isArray(dryRunEntries) ? dryRunEntries[0] : dryRunEntries;
ensure(Array.isArray(dryRunEntry?.files), 'npm pack --dry-run did not return a files list.');
validatePackedFiles(dryRunEntry.files);

console.error('[agentune] Installing tarball smoke test...');
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentune-tarball-'));

try {
  const tarballName = runText(NPM, ['pack', '--pack-destination', packDir, '--quiet'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .at(-1);

  ensure(Boolean(tarballName), 'npm pack did not emit a tarball name.');
  verifyInstalledTarball(path.join(packDir, tarballName));
} finally {
  removeDir(packDir);
}

console.error('[agentune] Publish verification passed.');
