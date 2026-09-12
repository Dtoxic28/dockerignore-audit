import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { auditContext } from '../src/index.js';
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


const schema = JSON.parse(await readFile(new URL('./fixtures/sarif-schema-2.1.0.json', import.meta.url), 'utf8'));
const validator = new Ajv({ strict: false, allErrors: true });
addFormats(validator);
const validateSarif = validator.compile(schema);

function reportAt(context, source) {
  return { context, dockerfile: 'Dockerfile', diagnostics: [{
    code: 'path-test', severity: 'warning', message: 'Context path.', source, line: 2, column: 3,
  }] };
}

const portablePaths = [
  ['/repo', '/repo/dir/file.txt', 'dir/file.txt'],
  ['C:/repo', 'c:\\repo\\dir\\file.txt', 'dir/file.txt'],
  ['C:/repo', 'D:/other/secret.txt', 'file:///D:/other/secret.txt'],
  ['C:/repo', '//server/share/secret.txt', 'file://server/share/secret.txt'],
  ['//server/share/repo', '//server/share/repo/src/main.js', 'src/main.js'],
  ['/repo', '/outside/a #?%.txt', 'file:///outside/a%20%23%3F%25.txt'],
  ['/repo', 'C:/external/a #?%.txt', 'file:///C:/external/a%20%23%3F%25.txt'],
  ['C:/repo', '/outside/a.txt', 'file:///outside/a.txt'],
  ['/repo', 'dir/caf\u00e9-\u{1f600}.txt', 'dir/caf%C3%A9-%F0%9F%98%80.txt'],
  ['/repo', './dir/../a%20.txt', 'a%2520.txt'],
];

for (const [context, source, expected] of portablePaths) {
  test(`SARIF portable URI: ${JSON.stringify(source)}`, () => {
    const sarif = toSarif([reportAt(context, source)]);
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    assert.equal(uri, expected);
    assert.equal(validateSarif(sarif), true, JSON.stringify(validateSarif.errors));
  });
}

test('validates SARIF 2.1.0 with the official schema and URI formats', () => {
  const cases = [toSarif([]), toSarif([{ context: '/repo', diagnostics: [] }]), toSarif([
    reportAt('/repo', 'dir/caf\u00e9.txt'),
    { context: '/repo', diagnostics: ['error', 'warning', 'info'].map((severity) => ({
      code: `severity-${severity}`, severity, message: 'No location.', composeTarget: 'api',
    })) },
  ])];
  for (const document of cases) {
    assert.equal(validateSarif(document), true, JSON.stringify(validateSarif.errors));
  }
  const malformed = structuredClone(cases[2]);
  malformed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'bad path';
  assert.equal(validateSarif(malformed), false, 'URI format checking must be active');
  malformed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'good-path';
  malformed.runs[0].results[0].locations[0].physicalLocation.region.startLine = 0;
  assert.equal(validateSarif(malformed), false, 'Region validation must be active');
});


test('real audit diagnostics satisfy the official SARIF schema', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sarif-schema-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'secrets #1'));
  await writeFile(path.join(root, 'Dockerfile'), 'FROM scratch\nCOPY missing.txt /app/\nCOPY . /app/\n');
  await writeFile(path.join(root, '.dockerignore'), 'unused\n[\n');
  await writeFile(path.join(root, 'secrets #1', '.env'), 'SECRET=test\n');
  const report = await auditContext({ context: root });
  const sarif = toSarif([report]);
  assert.ok(report.diagnostics.some(({ code }) => code === 'invalid-rule'));
  assert.ok(report.diagnostics.some(({ code }) => code === 'exposed-env-file'));
  assert.equal(validateSarif(sarif), true, JSON.stringify(validateSarif.errors));
});
