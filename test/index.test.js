import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { auditContext, auditProject, discoverDockerfiles, explainPath } from '../src/index.js';
import { composeBuilds } from '../src/compose.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'src', 'cli.js');
const action = path.join(repository, 'src', 'action.js');

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

test('warns when an adjacent nested .dockerignore is inactive', async (context) => {
  const root = await fixture(context, {
    '.dockerignore': 'root-only.txt\n',
    'docker/Dockerfile': 'FROM scratch\n',
    'docker/.dockerignore': 'nested-only.txt\n',
  });

  const report = await auditContext({ context: root, dockerfile: 'docker/Dockerfile' });
  const diagnostic = report.diagnostics.find(({ code }) => code === 'inactive-adjacent-ignore-file');
  assert.equal(diagnostic.source, 'docker/.dockerignore');
  assert.match(diagnostic.message, /not active/);
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

test('discovers Dockerfiles below five directory levels', async (context) => {
  const root = await fixture(context, {
    'one/two/three/four/five/six/Dockerfile': 'FROM scratch\n',
  });

  assert.deepEqual(
    await discoverDockerfiles(root),
    ['one/two/three/four/five/six/Dockerfile'],
  );
});

test('resolves and deduplicates Docker Compose build contexts', () => {
  const base = path.resolve('compose-project');
  const { builds, skipped } = composeBuilds({
    services: {
      api: {
        build: {
          context: 'services/api',
          dockerfile: 'Containerfile',
          additional_contexts: {
            shared: 'shared',
            image: 'docker-image://alpine:latest',
          },
        },
      },
      inline: {
        build: {
          context: 'services/inline',
          dockerfile_inline: 'FROM scratch\nCOPY . /app\n',
        },
      },
      remote: { build: 'https://github.com/example/project.git' },
      worker: { build: { context: 'services/api', dockerfile: 'Containerfile' } },
    },
  }, base);

  assert.deepEqual(builds, [
    {
      context: path.resolve(base, 'services/api'),
      dockerfile: path.resolve(base, 'services/api', 'Containerfile'),
      dockerfileText: null,
      composeTargets: ['api', 'worker'],
    },
    {
      context: path.resolve(base, 'shared'),
      dockerfile: null,
      dockerfileText: null,
      composeTargets: ['api:shared'],
    },
    {
      context: path.resolve(base, 'services/inline'),
      dockerfile: null,
      dockerfileText: 'FROM scratch\nCOPY . /app\n',
      composeTargets: ['inline'],
    },
  ]);
  assert.deepEqual(skipped, [
    { target: 'api:image', context: 'docker-image://alpine:latest' },
    { target: 'remote', context: 'https://github.com/example/project.git' },
  ]);
});

test('treats regex metacharacters as literal dockerignore characters', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'secret+prod.key\na(b)c.txt\n',
    'secret+prod.key': 'ignored\n',
    'secretprod.key': 'exposed\n',
    'a(b)c.txt': 'ignored\n',
  });

  const report = await auditContext({ context: root });
  assert.equal(report.files.find(({ path: pathname }) => pathname === 'secret+prod.key').included, false);
  assert.equal(report.files.find(({ path: pathname }) => pathname === 'secretprod.key').included, true);
  assert.equal(report.files.find(({ path: pathname }) => pathname === 'a(b)c.txt').included, false);
  assert.ok(report.diagnostics.some(({ code, path: pathname }) =>
    code === 'exposed-private-key' && pathname === 'secretprod.key'));
  assert.ok(!report.diagnostics.some(({ code }) => code === 'invalid-rule'));
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

test('uses Docker COPY glob semantics', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY *.{js,ts} /app/\n',
    '.dockerignore': '',
    'app.js': 'console.log(1);\n',
  });

  const report = await auditContext({ context: root });
  assert.ok(report.diagnostics.some(({ code }) => code === 'copy-source-missing'));
});

test('supports COPY --parents globstar sources', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\nCOPY --parents **/*.js /app/\n',
    '.dockerignore': '',
    'src/deep/app.js': 'console.log(1);\n',
  });

  const report = await auditContext({ context: root });
  assert.ok(!report.diagnostics.some(({ code }) => code === 'copy-source-missing'));
});

test('skips Dockerfile heredoc bodies and continuation comments', async (context) => {
  const root = await fixture(context, {
    Dockerfile: [
      'FROM scratch',
      'COPY <<EOF /message',
      'COPY not-a-context-source /bad',
      'EOF',
      'COPY present.txt \\',
      '# ignored continuation comment',
      'missing.txt /app/',
      '',
    ].join('\n'),
    '.dockerignore': '',
    'present.txt': 'present\n',
  });

  const report = await auditContext({ context: root });
  const missing = report.diagnostics.filter(({ code }) => code === 'copy-source-missing');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /missing\.txt/);
});

test('CLI emits JSON and applies failure thresholds', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'unused\nignored.txt\n',
    'ignored.txt': 'ignored\n',
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

  const ignoredRun = spawnSync(process.execPath, [cli, root, '--fail-on', 'warning', '--ignore', 'unused-rule'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(ignoredRun.status, 0, ignoredRun.stderr);
  assert.doesNotMatch(ignoredRun.stdout, /unused-rule/);

  const listRun = spawnSync(process.execPath, [cli, root, '--list', 'ignored'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(listRun.status, 0, listRun.stderr);
  assert.match(listRun.stdout, /ignored files \(1\):/);
  assert.match(listRun.stdout, /ignored\.txt/);

  const githubRun = spawnSync(process.execPath, [cli, root, '--github'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(githubRun.status, 0, githubRun.stderr);
  assert.match(githubRun.stdout, /::warning title=dockerignore-audit\/unused-rule,file=\.dockerignore,line=1,col=1::/);

  const invalidRun = spawnSync(process.execPath, [cli, root, '--fail-on', 'constructor'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(invalidRun.status, 2, invalidRun.stderr);
  assert.match(invalidRun.stderr, /error, warning, or info/);

  const conflictingRun = spawnSync(process.execPath, [
    cli,
    root,
    '--compose',
    'compose.yaml',
    '--dockerfile',
    'Dockerfile',
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(conflictingRun.status, 2, conflictingRun.stderr);
  assert.match(conflictingRun.stderr, /cannot be combined/);
});

test('validates public limits and CLI byte overflow', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': '',
  });

  await assert.rejects(
    auditContext({ context: root, maxBytes: Number.POSITIVE_INFINITY }),
    /maxBytes must be a non-negative finite number/,
  );
  await assert.rejects(
    auditContext({ context: root, maxFiles: '10' }),
    /maxFiles must be a non-negative finite number/,
  );

  const overflow = spawnSync(process.execPath, [cli, root, '--max-bytes', '9000000000000000000B'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(overflow.status, 2, overflow.stderr);
  assert.match(overflow.stderr, /must fit a safe integer/);
});

test('writes SARIF and suppresses unchanged baseline diagnostics', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'unused\nignored.txt\n',
    'ignored.txt': 'ignored\n',
  });
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'dockerignore-audit-output-'));
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const baseline = path.join(outputDirectory, 'baseline.json');
  const sarif = path.join(outputDirectory, 'results.sarif');

  const initial = spawnSync(process.execPath, [cli, root, '--json', '--fail-on', 'warning'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(initial.status, 1, initial.stderr);
  await writeFile(baseline, initial.stdout);

  const baselineRun = spawnSync(process.execPath, [
    cli, root, '--json', '--baseline', baseline, '--fail-on', 'warning',
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(baselineRun.status, 0, baselineRun.stderr);
  const baselineReport = JSON.parse(baselineRun.stdout)[0];
  assert.deepEqual(baselineReport.diagnostics, []);
  assert.equal(baselineReport.baselineSuppressed, 1);

  const sarifRun = spawnSync(process.execPath, [
    cli, root, '--sarif', sarif, '--fail-on', 'warning',
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(sarifRun.status, 1, sarifRun.stderr);
  const sarifReport = JSON.parse(await readFile(sarif, 'utf8'));
  assert.equal(sarifReport.version, '2.1.0');
  assert.equal(sarifReport.runs[0].results[0].ruleId, 'unused-rule');
});

test('rejects missing or invalid baselines and SARIF destinations', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': '',
  });
  const missingBaseline = spawnSync(process.execPath, [
    cli, root, '--baseline', path.join(root, 'missing.json'), '--json',
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(missingBaseline.status, 2, missingBaseline.stderr);
  assert.match(missingBaseline.stderr, /Baseline file could not be read/);

  const invalidBaseline = path.join(root, 'invalid.json');
  await writeFile(invalidBaseline, '{not-json');
  const invalid = spawnSync(process.execPath, [
    cli, root, '--baseline', invalidBaseline, '--json',
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /Baseline file is not valid JSON/);

  const sarifFailure = spawnSync(process.execPath, [
    cli, root, '--sarif', path.join(root, 'missing', 'results.sarif'),
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(sarifFailure.status, 2, sarifFailure.stderr);
  assert.match(sarifFailure.stderr, /dockerignore-audit:/);
});

test('GitHub Action forwards inputs and exit status', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'unused\n',
  });
  const environment = {
    ...process.env,
    INPUT_CONTEXT: root,
    INPUT_FAIL_ON: 'warning',
    INPUT_SARIF: path.join(root, 'action.sarif'),
  };

  const failing = spawnSync(process.execPath, [action], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /dockerignore-audit\/unused-rule/);
  const actionSarif = JSON.parse(await readFile(path.join(root, 'action.sarif'), 'utf8'));
  assert.equal(actionSarif.version, '2.1.0');

  const baseline = path.join(root, 'baseline.json');
  await writeFile(baseline, JSON.stringify([{
    context: root,
    dockerfile: 'Dockerfile',
    diagnostics: [{
      code: 'unused-rule',
      severity: 'warning',
      message: 'Rule does not change any path in the current context: \"unused\".',
      source: '.dockerignore',
      line: 1,
      column: 1,
    }],
  }]), 'utf8');
  const passing = spawnSync(process.execPath, [action], {
    cwd: root,
    env: { ...environment, INPUT_BASELINE: baseline },
    encoding: 'utf8',
  });
  assert.equal(passing.status, 0, passing.stderr);
});

test('rejects explanations outside the context', async (context) => {
  const root = await fixture(context, {
    Dockerfile: 'FROM scratch\n',
    '.dockerignore': 'tmp\n',
  });
  const report = await auditContext({ context: root });
  assert.throws(() => explainPath(report, path.resolve(root, '..', 'outside')), /outside/);
  if (process.platform === 'win32') {
    const otherDrive = `${root[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\outside\\secret.env`;
    assert.throws(() => explainPath(report, otherDrive), /outside/);
  }
});

test('release workflow publishes only tagged packages', async () => {
  const workflow = await readFile(path.join(repository, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(workflow.includes("tags: ['v*.*.*']"));
  assert.ok(workflow.includes('npm publish --access public'));
  assert.ok(workflow.includes('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'));
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
