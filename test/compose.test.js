import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { promisify } from 'node:util';

// Stub only the subprocess boundary; run the real inspectCompose implementation.
const originalExecFile = childProcess.execFile;
const calls = [];
let result;
const fakeExecFile = () => { throw new Error('Expected promisified execFile'); };
fakeExecFile[promisify.custom] = async (...args) => {
  calls.push(args);
  if (result instanceof Error) throw result;
  return result;
};
childProcess.execFile = fakeExecFile;
syncBuiltinESMExports();
const { inspectCompose } = await import('../src/compose.js');
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});
beforeEach(() => { calls.length = 0; result = { stdout: '{"services":{}}', stderr: '' }; });
const root = path.resolve('compose project');

test('inspectCompose forwards ordered file arguments without a shell and bounds execution', async () => {
  const files = ['compose.yaml', 'overlays/prod;echo ignored.yaml'];
  const output = await inspectCompose(root, files);
  assert.deepEqual(output, { builds: [], skipped: [], source: path.join(root, files[0]) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], 'docker');
  assert.deepEqual(calls[0][1], [
    'compose', '--file', path.resolve(root, files[0]), '--file', path.resolve(root, files[1]),
    'config', '--format', 'json',
  ]);
  assert.deepEqual(calls[0][2], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
});

test('inspectCompose rejects malformed file arguments before execution', async () => {
  for (const files of [undefined, [], 'compose.yaml', [null], [''], [' '], ['-'], ['a\0b'], new Array(1)]) {
    await assert.rejects(inspectCompose(root, files), TypeError);
  }
  assert.equal(calls.length, 0);
});

for (const [name, properties, expected] of [
  ['missing executable', { code: 'ENOENT' }, /Docker Compose is required/],
  ['stderr failure', { code: 1, stderr: ' invalid compose yaml \n' }, /config failed: invalid compose yaml$/],
  ['stdout fallback', { code: 1, stderr: '   ', stdout: ' config invalid \n' }, /config failed: config invalid$/],
  ['empty output fallback', { code: 'EACCES' }, /config failed: process failed$/],
  ['output overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }, /config failed/],
  ['timeout', { killed: true, signal: 'SIGTERM' }, /timed out after 30000ms/],
]) {
  test(`inspectCompose handles ${name} and preserves the cause`, async () => {
    result = Object.assign(new Error('process failed'), properties);
    await assert.rejects(inspectCompose(root, ['compose.yaml']), (error) => {
      assert.match(error.message, expected);
      assert.equal(error.cause, result);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('inspectCompose reports invalid JSON without leaking raw output', async () => {
  result.stdout = '{private-data';
  await assert.rejects(inspectCompose(root, ['compose.yaml']), (error) => {
    assert.equal(error.message, 'docker compose config returned invalid JSON.');
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('inspectCompose rejects invalid JSON model shapes', async () => {
  for (const value of [null, [], 1, 'text', { services: [] }, { services: 'bad' }]) {
    result.stdout = JSON.stringify(value);
    await assert.rejects(inspectCompose(root, ['compose.yaml']), TypeError);
  }
});

test('inspectCompose uses the first file directory and preserves inline/additional targets', async () => {
  result.stdout = JSON.stringify({ services: {
    api: { build: { context: '../app', dockerfile_inline: 'FROM scratch\n', additional_contexts: { shared: '../shared' } } },
    image: { image: 'image-only' }, remote: { build: 'https://example.test/source.git' },
  } });
  const output = await inspectCompose(root, ['deploy/compose.yaml']);
  assert.deepEqual(output.builds, [
    { context: path.join(root, 'app'), dockerfile: null, dockerfileText: 'FROM scratch\n', composeTargets: ['api'] },
    { context: path.join(root, 'shared'), dockerfile: null, dockerfileText: null, composeTargets: ['api:shared'] },
  ]);
  assert.deepEqual(output.skipped, [{ target: 'remote', context: 'https://example.test/source.git' }]);
});
