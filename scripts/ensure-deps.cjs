#!/usr/bin/env node
const { existsSync } = require('fs');
const { spawnSync } = require('child_process');

const requiredGroups = [
  ['node_modules/typescript/lib/tsc.js'],
  ['node_modules/tsx/dist/cli.mjs'],
  ['node_modules/@ableton-extensions/cli/dist/cli.mjs', 'node_modules/@ableton-extensions/cli/dist/cli.cjs'],
  ['node_modules/@ableton-extensions/sdk/dist/index.d.mts', 'node_modules/@ableton-extensions/sdk/dist/index.d.cts', 'node_modules/@ableton-extensions/sdk/dist/index.mjs', 'node_modules/@ableton-extensions/sdk/dist/index.cjs'],
];

function groupOk(group) {
  return group.some((p) => existsSync(p));
}

function missingGroups() {
  return requiredGroups.filter((group) => !groupOk(group));
}

let missing = missingGroups();
if (missing.length === 0) {
  process.exit(0);
}

console.log('[tracker-importer] Dependencies are missing or incomplete:');
for (const group of missing) console.log(`  - one of: ${group.join(' | ')}`);
console.log('[tracker-importer] Running npm install --no-package-lock ...');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['install', '--no-package-lock'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  console.error('[tracker-importer] npm install failed. Please remove node_modules and run npm install manually.');
  process.exit(result.status || 1);
}

missing = missingGroups();
if (missing.length > 0) {
  console.error('[tracker-importer] Dependencies are still incomplete after npm install:');
  for (const group of missing) console.error(`  - one of: ${group.join(' | ')}`);
  process.exit(1);
}
