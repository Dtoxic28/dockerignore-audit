import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDockerIgnore, matchFilePattern } from '../src/matcher.js';

const ALPHABET = 'abXYZ012_./\\!?*[]^-???';

function randomGenerator(seed = 0x9e3779b9) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
}

function randomText(next, maxLength = 24) {
  let value = '';
  const length = next() % maxLength;
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[next() % ALPHABET.length];
  }
  return value;
}

test('fuzzes matcher inputs without unexpected exceptions', () => {
  const next = randomGenerator();
  let invalidPatterns = 0;
  let matched = 0;

  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const pattern = randomText(next);
    const pathname = randomText(next);
    const compiled = compileDockerIgnore(pattern, '.dockerignore');
    assert.doesNotThrow(() => compiled.matcher.ignores(pathname));

    try {
      const result = matchFilePattern(pattern, pathname, { globstar: Boolean(next() & 1) });
      assert.equal(typeof result, 'boolean');
      matched += result ? 1 : 0;
      if (!pattern.includes('**')) {
        assert.equal(matchFilePattern(pattern, pathname), result);
      }
    } catch (error) {
      invalidPatterns += 1;
      assert.ok(error instanceof SyntaxError, `${pattern}: ${error}`);
      assert.match(error.message, /Invalid file pattern/);
    }
  }

  assert.ok(invalidPatterns > 0);
  assert.ok(matched > 0);
});
