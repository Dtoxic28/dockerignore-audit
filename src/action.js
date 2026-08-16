import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const args = [input('context') || '.', '--github'];

for (const [name, option] of [
  ['dockerfile', '--dockerfile'],
  ['fail-on', '--fail-on'],
  ['max-bytes', '--max-bytes'],
  ['max-files', '--max-files'],
]) {
  const value = input(name);
  if (value) args.push(option, value);
}

for (const code of input('ignore').split(/[\s,]+/).filter(Boolean)) {
  args.push('--ignore', code);
}

for (const file of input('compose').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
  args.push('--compose', file);
}

const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`dockerignore-audit action: ${result.error.message}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = result.status ?? 2;
}

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] ?? '').trim();
}
