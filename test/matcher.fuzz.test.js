import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileDockerIgnore, matchFilePattern } from '../src/matcher.js';
import { matcherCases, SEED } from '../scripts/matcher-cases.js';

const platform = process.platform === 'win32' ? 'win32' : 'posix';
const golden = JSON.parse(await readFile(new URL(`./fixtures/matcher-${platform}.json`, import.meta.url), 'utf8'));
const cases = matcherCases();
assert.equal(golden.seed, SEED);
assert.equal(golden.results.length, cases.length);

for (const kind of ['copy', 'ignore']) {
  test(`differential fuzz: ${kind} vs pinned Go/Moby oracle (${platform})`, (context) => {
    const mismatches = [];
    const totals = { valid: 0, invalid: 0, matching: 0 };
    for (let index = 0; index < cases.length; index++) {
      const input = cases[index];
      if (input.kind !== kind) continue;
      let actual;
      if (kind === 'copy') {
        try {
          const matched = matchFilePattern(input.pattern, input.path);
          assert.equal(typeof matched, 'boolean');
          actual = matched ? 1 : 0;
        } catch (error) {
          assert.ok(error instanceof SyntaxError, `${index}: ${error}`);
          actual = -1;
        }
      } else {
        const compiled = compileDockerIgnore(input.pattern, '.dockerignore');
        actual = compiled.diagnostics.length ? -1 : compiled.matcher.ignores(input.path) ? 1 : 0;
      }
      const expected = golden.results[index];
      totals[expected === -1 ? 'invalid' : 'valid']++;
      if (expected === 1) totals.matching++;
      if (actual !== expected) mismatches.push({ index, ...input, expected, actual });
    }
    context.diagnostic(JSON.stringify({ seed: SEED, kind, ...totals }));
    assert.ok(totals.invalid > 0 && totals.matching > 0 && totals.valid > totals.matching);
    assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 30), null, 2));
  });
}
