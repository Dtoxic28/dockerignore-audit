import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REMOTE_CONTEXT = /^(?:docker-image|git|http|https|oci-layout|service|ssh):/i;
const SCP_CONTEXT = /^[^/\\@\s]+@[^/\\:\s]+:/;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function inspectCompose(projectDirectory, composeFiles) {
  if (!Array.isArray(composeFiles) || composeFiles.length === 0) {
    throw new TypeError('composeFiles must contain at least one Compose file.');
  }
  if (composeFiles.some((file) => typeof file !== 'string' || !file.trim() || file === '-')) {
    throw new TypeError('composeFiles must contain local file paths.');
  }

  const files = composeFiles.map((file) => path.resolve(projectDirectory, file));
  const args = ['compose'];
  for (const file of files) args.push('--file', file);
  args.push('config', '--format', 'json');

  let stdout;
  try {
    ({ stdout } = await execFileAsync('docker', args, {
      cwd: projectDirectory,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Docker Compose is required for --compose.');
    }
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`docker compose config failed: ${detail}`);
  }

  let model;
  try {
    model = JSON.parse(stdout);
  } catch (error) {
    throw new Error('docker compose config returned invalid JSON.', { cause: error });
  }

  return {
    ...composeBuilds(model, path.dirname(files[0])),
    source: files[0],
  };
}

export function composeBuilds(model, baseDirectory = '.') {
  const services = model?.services;
  if (services == null) return { builds: [], skipped: [] };
  if (typeof services !== 'object' || Array.isArray(services)) {
    throw new TypeError('Compose config services must be an object.');
  }

  const grouped = new Map();
  const skipped = [];

  for (const serviceName of Object.keys(services).sort()) {
    const rawBuild = services[serviceName]?.build;
    if (rawBuild == null) continue;
    const build = typeof rawBuild === 'string' ? { context: rawBuild } : rawBuild;
    if (!build || typeof build !== 'object' || Array.isArray(build)) continue;

    addBuild(grouped, skipped, baseDirectory, {
      target: serviceName,
      context: build.context ?? '.',
      dockerfile: build.dockerfile_inline == null ? build.dockerfile ?? 'Dockerfile' : null,
      dockerfileText: typeof build.dockerfile_inline === 'string' ? build.dockerfile_inline : null,
    });

    const contexts = additionalContexts(build.additional_contexts)
      .sort(([left], [right]) => compareText(left, right));
    for (const [name, context] of contexts) {
      addBuild(grouped, skipped, baseDirectory, {
        target: `${serviceName}:${name}`,
        context,
        dockerfile: null,
        dockerfileText: null,
      });
    }
  }

  const builds = [...grouped.values()]
    .map((build) => ({ ...build, composeTargets: build.composeTargets.sort() }))
    .sort((left, right) => compareText(left.composeTargets[0], right.composeTargets[0]));
  return { builds, skipped };
}

function addBuild(grouped, skipped, baseDirectory, build) {
  if (typeof build.context !== 'string') {
    skipped.push({ target: build.target, context: build.context });
    return;
  }
  const contextInput = build.context.trim();
  if (!contextInput || isRemoteContext(contextInput)) {
    skipped.push({ target: build.target, context: build.context });
    return;
  }

  const context = path.resolve(baseDirectory, contextInput);
  const dockerfile = build.dockerfile == null || path.isAbsolute(build.dockerfile)
    ? build.dockerfile
    : path.resolve(context, build.dockerfile);
  const key = `${context}\0${dockerfile ?? ''}\0${build.dockerfileText ?? ''}`;
  const existing = grouped.get(key);
  if (existing) {
    existing.composeTargets.push(build.target);
    return;
  }

  grouped.set(key, {
    context,
    dockerfile,
    dockerfileText: build.dockerfileText,
    composeTargets: [build.target],
  });
}

function additionalContexts(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry !== 'string') return [];
      const separator = entry.indexOf('=');
      return separator < 1 ? [] : [[entry.slice(0, separator), entry.slice(separator + 1)]];
    });
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function isRemoteContext(value) {
  return value === '-' || REMOTE_CONTEXT.test(value) || SCP_CONTEXT.test(value);
}
