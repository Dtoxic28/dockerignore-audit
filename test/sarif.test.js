import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { toSarif } from '../src/sarif.js';

test('emits deterministic SARIF diagnostics with locations and fingerprints', () => {
  const sarif = toSarif([{
    context: 'C:/repo',
    dockerfile: 'Dockerfile',
    composeTargets: ['api'],
    diagnostics: [
      {
        code: 'exposed-env-file',
        severity: 'error',
        message: 'Environment file is included in the build context.',
        path: '.env',
      },
      {
        code: 'missing-ignore-file',
        severity: 'warning',
        message: 'No .dockerignore file protects this build context.',
        source: '.dockerignore',
        line: 1,
        column: 1,
      },
    ],
  }]);

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.deepEqual(sarif.runs[0].tool.driver.rules.map(({ id }) => id), [
    'exposed-env-file',
    'missing-ignore-file',
  ]);
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, '.env');
  assert.equal(sarif.runs[0].results[1].locations[0].physicalLocation.region.startLine, 1);
  assert.match(sarif.runs[0].results[0].partialFingerprints.primaryLocationLineHash, /^[a-f0-9]{64}$/);
});

test('deduplicates rules and normalizes absolute artifact paths', () => {
  const context = process.cwd();
  const source = path.join(context, '.dockerignore');
  const sarif = toSarif([{
    context,
    dockerfile: 'Dockerfile',
    diagnostics: [
      { code: 'duplicate', severity: 'info', message: 'z', source, line: 2 },
      { code: 'duplicate', severity: 'info', message: 'a', source, line: 2 },
    ],
  }]);
  assert.deepEqual(sarif.runs[0].tool.driver.rules.map(({ id }) => id), ['duplicate']);
  assert.deepEqual(sarif.runs[0].results.map(({ message }) => message.text), ['a', 'z']);
  assert.equal(
    sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    '.dockerignore',
  );
});


test('encodes SARIF path characters and handles Windows absolute paths', () => {
  const sarif = toSarif([{
    context: 'C:/repo with spaces',
    diagnostics: [
      {
        code: 'path-test',
        severity: 'warning',
        message: 'path',
        source: 'C:/repo with spaces/dir with spaces/file#?.txt',
      },
      {
        code: 'outside-test',
        severity: 'warning',
        message: 'outside',
        source: 'C:/other/secret.txt',
      },
    ],
  }]);
  const results = sarif.runs[0].results;
  assert.equal(
    results.find(({ ruleId }) => ruleId === 'path-test').locations[0].physicalLocation.artifactLocation.uri,
    'dir%20with%20spaces/file%23%3F.txt',
  );
  assert.equal(
    results.find(({ ruleId }) => ruleId === 'outside-test').locations[0].physicalLocation.artifactLocation.uri,
    'file:///C:/other/secret.txt',
  );
});
