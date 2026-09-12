import assert from 'node:assert/strict';
import test from 'node:test';
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