import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDockerIgnore, matchFilePattern } from '../src/matcher.js';

test('matches current Moby dockerignore semantics', () => {
  const cases = [
    [['**'], 'file', true],
    [['**/*.txt'], 'file.txt', true],
    [['a/*.txt'], 'a/dir/file.txt', false],
    [['dir/**'], 'dir/dir2/file', true],
    [['**/dir'], 'dir/file', true],
    [['**file'], 'dir/profile', true],
    [['a(b)c/def'], 'a(b)c/def', true],
    [['a.|)$(}+{bc'], 'a.|)$(}+{bc', true],
    [['dist/*.whl'], 'dist/pkg-1.0+meta.whl', true],
    [['docs', '!docs/README.md'], 'docs/README.md', false],
    [['**', '!util/docker/web'], 'util/docker/web/file', false],
  ];

  for (const [patterns, pathname, ignored] of cases) {
    const compiled = compileDockerIgnore(patterns.join('\n'), '.dockerignore');
    assert.deepEqual(compiled.diagnostics, [], patterns.join('\n'));
    assert.equal(compiled.matcher.ignores(pathname), ignored, `${patterns} on ${pathname}`);
  }
});

test('reports malformed dockerignore patterns', () => {
  for (const pattern of ['!', '[-x]', '[x-]', 'a[']) {
    const compiled = compileDockerIgnore(pattern, '.dockerignore');
    assert.equal(compiled.diagnostics[0]?.code, 'invalid-rule', pattern);
  }
});

test('matches COPY globs without shell extensions', () => {
  assert.equal(matchFilePattern('*.js', 'app.js'), true);
  assert.equal(matchFilePattern('*.js', 'src/app.js'), false);
  assert.equal(matchFilePattern('*.{js,ts}', 'app.js'), false);
  assert.equal(matchFilePattern('**/*.js', 'app.js'), false);
  assert.equal(matchFilePattern('**/*.js', 'src/app.js'), true);
  assert.equal(matchFilePattern('**/*.js', 'src/deep/app.js'), false);
  assert.equal(matchFilePattern('**/*.js', 'src/deep/app.js', { globstar: true }), true);
  assert.throws(() => matchFilePattern('[x-', 'x'), /Invalid file pattern/);
});


test('keeps Moby regex boundaries and literal closing brackets', () => {
  for (const [pattern, pathname, expected] of [
    ['a]', 'a]', true], ['*.txt', 'a.txt\n', false],
    ['**/*.txt', 'dir\r/a.txt', true], ['**/*.txt', 'dir\u2028/a.txt', true],
    ['**/*.txt', 'dir\n/a.txt', false],
  ]) {
    const compiled = compileDockerIgnore(pattern, '.dockerignore');
    assert.deepEqual(compiled.diagnostics, []);
    assert.equal(compiled.matcher.ignores(pathname), expected, JSON.stringify({ pattern, pathname }));
  }
});

test('uses native backslash semantics without losing POSIX filename characters', () => {
  const pattern = String.raw`a\\`;
  const pathname = process.platform === 'win32' ? 'a' : 'a\\';
  const compiled = compileDockerIgnore(pattern, '.dockerignore');
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.matcher.ignores(pathname), true);
  const escaped = compileDockerIgnore(String.raw`\!name`, '.dockerignore');
  assert.equal(escaped.matcher.ignores('!name'), process.platform !== 'win32');
});
