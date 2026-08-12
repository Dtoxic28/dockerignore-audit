import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { auditContext, auditProject, discoverDockerfiles, explainPath } from '../src/index.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'src', 'cli.js');

test('audits context exposure, rule effects, and COPY sources', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY src/ /app/\nCOPY missing.txt /tmp/\n',
    '.dockerignore': 'node_modules\n*.pem\nunused\nsrc/**\n!src/keep.js\n',
    '.env': 'SECRET=value\n',
    '.git/config': '[core]\n',
    'node_modules/dependency.js': 'module.exports = 1;\n',
    'src/drop.js': 'drop\n',
    'src/keep.js': 'keep\n',
  });

  const report = await auditContext({ context: root });
  const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

  assert.deepEqual(
    codes.filter((code) => code === 'copy-source-missing'),
    ['copy-source-missing'],
  );
  assert.ok(codes.includes('copy-source-partially-ignored'));
  assert.ok(codes.includes('exposed-env-file'));
  assert.ok(codes.includes('included-git-history'));
  assert.equal(report.files.find((file) => file.path === 'src/drop.js').included, false);
  assert.equal(report.files.find((file) => file.path === 'src/keep.js').included, true);
  assert.equal(report.rules.find((rule) => rule.pattern === 'unused').used, false);

  assert.deepEqual(explainPath(report, 'src/drop.js'), {
    path: 'src/drop.js',
    ignored: true,
    included: false,
    rule: {
      line: 4,
      pattern: 'src/**',
      negative: false,
      source: '.dockerignore',
    },
  });
  assert.equal(explainPath(report, 'src/keep.js').rule.line, 5);
});

test('prefers Dockerfile-specific ignore files', async (context) => {
  const root = await fixture(context, {
    '.dockerignore': 'secret.txt\n',
    Dockerfile: 'FROM scratch\nCOPY . /app\n',
    'Dockerfile.dockerignore': '!secret.txt\n',
    'secret.txt': 'secret\n',
  });

  const report = await auditContext({ context: root });
  assert.equal(report.ignoreFile, 'Dockerfile.dockerignore');
  assert.equal(report.files.find((file) => file.path === 'secret.txt').included, true);
  assert.equal(explainPath(report, 'secret.txt').ignored, false);
});

test('discovers Dockerfiles and audits each specific ignore file', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    'docker/lint.Dockerfile': 'FROM scratch\n',
    'docker/lint.Dockerfile.dockerignore': '*.log\n',
    'debug.log': 'root log\n',
  });

  assert.deepEqual(await discoverDockerfiles(root), ['Dockerfile', 'docker/lint.Dockerfile']);
  const reports = await auditProject({ context: root });
  assert.equal(reports.length, 2);
  assert.equal(
    reports.find((report) => report.dockerfile === 'docker/lint.Dockerfile').ignoreFile,
    'docker/lint.Dockerfile.dockerignore',
  );
});

test('reports an ignored COPY source and the deciding rule', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY secret.txt /run/\n',
    '.dockerignore': 'secret.txt\n',
    'secret.txt': 'secret\n',
  });

  const report = await auditContext({ context: root });
  const diagnostic = report.diagnostics.find(({ code }) => code === 'copy-source-ignored');
  assert.match(diagnostic.message, /secret\.txt.*line 1/);
});

test('reports active Docker metadata as unavailable to COPY', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY Dockerfile /run/\n',
    '.dockerignore': '',
  });

  const report = await auditContext({ context: root });
  assert.ok(report.diagnostics.some(({ code }) => code === 'copy-source-unavailable'));
});

test('CLI emits JSON and applies failure thresholds', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'unused\n',
  });

  const warningRun = spawnSync(process.execPath, [cli, root, '--json', '--fail-on', 'warning'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(warningRun.status, 1, warningRun.stderr);
  assert.equal(JSON.parse(warningRun.stdout)[0].diagnostics[0].code, 'unused-rule');

  const errorRun = spawnSync(process.execPath, [cli, root, '--fail-on', 'error'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(errorRun.status, 0, errorRun.stderr);
});

test('rejects explanations outside the context', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'tmp\n',
  });
  const report = await auditContext({ context: root });
  assert.throws(() => explainPath(report, path.resolve(root, '..', 'outside')), /outside/);
});

test('CI workflow keeps valid matrix interpolation', async () => {
  const workflow = await readFile(path.join(repository, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(workflow.includes('node-version: ${{ matrix.node }}'));
  assert.ok(!workflow.includes('${${'));
});

async function fixture(context, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'dockerignore-audit-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}
