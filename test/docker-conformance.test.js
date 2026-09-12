import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditCompose, auditContext } from '../src/index.js';
import { composeBuilds } from '../src/compose.js';

const enabled = process.env.DOCKERIGNORE_AUDIT_DOCKER_TEST === '1';

test('matches Docker BuildKit context selection', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY . /context\n',
    '.dockerignore': 'drop+prod.txt\ndocs\n!docs/README.md\n**/*.tmp\n',
    'drop+prod.txt': 'ignored literal\n',
    'dropprod.txt': 'included lookalike\n',
    'docs/README.md': 'included exception\n',
    'logs/debug.tmp': 'ignored globstar\n',
    'keep.txt': 'included\n',
  });

  const report = await auditContext({ context: root, dockerfile: 'Dockerfile' });
  assert.deepEqual(includedContextFiles(report, 'Dockerfile'), [
    'docs/README.md',
    'dropprod.txt',
    'keep.txt',
  ]);
  if (enabled) await assertMatchesDocker(context, root, 'Dockerfile');
});

test('matches Dockerfile-specific ignore precedence', async (context) => {
  const root = await fixture(context, {
    '.dockerignore': 'root-hidden.txt\n',
    'docker/build.Dockerfile': 'FROM scratch\nCOPY . /context\n',
    'docker/build.Dockerfile.dockerignore': 'specific-hidden.txt\n',
    'root-hidden.txt': 'included by specific rules\n',
    'specific-hidden.txt': 'ignored by specific rules\n',
    'keep.txt': 'included\n',
  });

  const report = await auditContext({ context: root, dockerfile: 'docker/build.Dockerfile' });
  assert.equal(report.ignoreFile, 'docker/build.Dockerfile.dockerignore');
  assert.deepEqual(includedContextFiles(report, 'docker/build.Dockerfile'), [
    'keep.txt',
    'root-hidden.txt',
  ]);
  if (enabled) await assertMatchesDocker(context, root, 'docker/build.Dockerfile');
});

test('resolves Docker Compose build contexts', async (context) => {
  const root = await fixture(context, {
    'compose.yaml': [
      'services:',
      '  api:',
      '    build:',
      '      context: ./services/api',
      '      dockerfile: Containerfile',
      '',
    ].join('\n'),
    'services/api/Containerfile': 'FROM scratch\nCOPY app.txt /app.txt\n',
    'services/api/.dockerignore': '*.log\n',
    'services/api/.env': 'SECRET=value\n',
    'services/api/app.txt': 'included\n',
  });

  const builds = composeBuilds({
    services: { api: { build: { context: './services/api', dockerfile: 'Containerfile' } } },
  }, root);
  assert.equal(builds.builds.length, 1);
  assert.deepEqual(builds.builds[0].composeTargets, ['api']);
  if (enabled) {
    const reports = await auditCompose({ context: root, composeFiles: ['compose.yaml'] });
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].composeTargets, ['api']);
    assert.equal(reports[0].dockerfile, 'Containerfile');
    assert.ok(reports[0].diagnostics.some(({ code }) => code === 'exposed-env-file'));
  }
});

function includedContextFiles(report, dockerfile) {
  const metadata = new Set([dockerfile, report.ignoreFile].filter(Boolean));
  return report.files
    .filter((file) => file.included && !metadata.has(file.path) && !file.path.endsWith('.dockerignore'))
    .map((file) => file.path)
    .sort();
}

async function assertMatchesDocker(context, root, dockerfile) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'dockerignore-audit-output-'));
  const output = path.join(temporary, 'root');
  context.after(() => rm(temporary, { recursive: true, force: true }));

  execFileSync('docker', [
    'buildx',
    'build',
    '--progress=plain',
    '--output',
    `type=local,dest=${output}`,
    '--file',
    path.join(root, ...dockerfile.split('/')),
    root,
  ], { stdio: 'inherit' });

  const report = await auditContext({ context: root, dockerfile });
  const metadata = new Set([dockerfile, report.ignoreFile].filter(Boolean));
  const expected = report.files
    .filter((file) => file.included && !metadata.has(file.path) && !file.path.endsWith('.dockerignore'))
    .map((file) => file.path)
    .sort();
  const actual = (await listFiles(path.join(output, 'context')))
    .filter((pathname) => !metadata.has(pathname) && !pathname.endsWith('.dockerignore'))
    .sort();
  assert.deepEqual(actual, expected);
}

async function listFiles(root, relative = '') {
  const files = [];
  const directory = await opendir(path.join(root, relative));
  for await (const entry of directory) {
    const pathname = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, pathname));
    else files.push(pathname);
  }
  return files;
}

async function fixture(context, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'dockerignore-audit-docker-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}
