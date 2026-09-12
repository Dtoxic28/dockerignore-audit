import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matcherCases, SEED } from './matcher-cases.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.env.MATCHER_ORACLE_PLATFORM ?? (process.platform === 'win32' ? 'win32' : 'posix');
assert.ok(['win32', 'posix'].includes(target));
const fixture = path.join(root, 'test', 'fixtures', `matcher-${target}.json`);
const go = process.env.GO ?? 'go';
const wasm = process.env.MATCHER_ORACLE_WASM;
const command = wasm ? process.execPath : go;
const args = wasm ? [process.env.MATCHER_ORACLE_WASM_RUNNER, wasm] : ['run', '.'];
const input = JSON.stringify(matcherCases());
const run = spawnSync(command, args, {
  cwd: path.join(root, 'test', 'fixtures', 'matcher-oracle'), input, encoding: 'utf8',
  windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
});
assert.ifError(run.error);
assert.equal(run.status, 0, run.stderr);
const actual = { seed: SEED, oracle: 'moby/patternmatcher@v0.6.1 + Go path.Match', results: JSON.parse(run.stdout) };
assert.equal(actual.results.length, matcherCases().length);
if (process.argv.includes('--update')) {
  await writeFile(fixture, `${JSON.stringify(actual)}\n`);
} else {
  const expected = JSON.parse(await readFile(fixture, 'utf8'));
  assert.deepEqual(actual, expected, 'Oracle changed; inspect mismatches before regenerating fixtures.');
}
console.log(`${target}: ${actual.results.length} independent oracle results ${process.argv.includes('--update') ? 'written' : 'verified'}`);
