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
