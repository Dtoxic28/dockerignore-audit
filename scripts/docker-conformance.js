import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
} catch {
  const required = process.env.DOCKERIGNORE_AUDIT_DOCKER_TEST_REQUIRED === '1';
  process.stderr.write(required
    ? 'Docker unavailable; BuildKit conformance is required.\n'
    : 'Docker unavailable; skipped BuildKit conformance.\n');
  process.exit(required ? 2 : 0);
}

const result = spawnSync(process.execPath, ['--test', 'test/docker-conformance.test.js'], {
  env: { ...process.env, DOCKERIGNORE_AUDIT_DOCKER_TEST: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 2);
