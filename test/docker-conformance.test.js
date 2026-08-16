import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditContext } from '../src/index.js';

const enabled = process.env.DOCKERIGNORE_AUDIT_DOCKER_TEST === '1';

test('matches Docker BuildKit context selection', { skip: !enabled }, async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY . /context\n',
    '.dockerignore': 'drop+prod.txt\ndocs\n!docs/README.md\n**/*.tmp\n',
    'drop+prod.txt': 'ignored literal\n',
    'dropprod.txt': 'included lookalike\n',
    'docs/README.md': 'included exception\n',
    'logs/debug.tmp': 'ignored globstar\n',
    'keep.txt': 'included\n',
  });

  await assertMatchesDocker(context, root, 'Dockerfile');
});

test('matches Dockerfile-specific ignore precedence', { skip: !enabled }, async (context) => {
  const root = await fixture(context, {
    '.dockerignore': 'root-hidden.txt\n',
    'docker/build.Dockerfile': 'FROM scratch\nCOPY . /context\n',
    'docker/build.Dockerfile.dockerignore': 'specific-hidden.txt\n',
    'root-hidden.txt': 'included by specific rules\n',
    'specific-hidden.txt': 'ignored by specific rules\n',
    'keep.txt': 'included\n',
  });

  await assertMatchesDocker(context, root, 'docker/build.Dockerfile');
});

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
