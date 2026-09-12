import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectCompose } from './compose.js';
import { compileDockerIgnore, evaluateIgnoreRules, matchFilePattern } from './matcher.js';

const INTERNAL = Symbol('dockerignore-audit');
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const DOCKERFILE_NAME = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function auditProject(options = {}) {
  const context = await resolveContext(options.context);
  const walked = await walkContext(context);
  const dockerfiles = options.dockerfile
    ? [resolveDockerfile(context, options.dockerfile)]
    : discoverDockerfilesFromEntries(walked.entries);

  if (dockerfiles.length === 0) {
    return [await auditContextInternal(context, undefined, options, walked)];
  }

  return Promise.all(
    dockerfiles.map((dockerfile) => auditContextInternal(context, dockerfile, options, walked)),
  );
}

export async function auditContext(options = {}) {
  const context = await resolveContext(options.context);
  const dockerfile = options.dockerfile
    ? resolveDockerfile(context, options.dockerfile)
    : await defaultDockerfile(context);
  const walked = await walkContext(context);
  return auditContextInternal(context, dockerfile, options, walked);
}

export async function auditCompose(options = {}) {
  const projectDirectory = await resolveContext(options.context);
  const { builds, skipped, source } = await inspectCompose(projectDirectory, options.composeFiles);
  if (builds.length === 0) {
    const targets = skipped.map(({ target }) => target).join(', ');
    throw new Error(`No local Docker Compose build contexts found${targets ? `; skipped: ${targets}.` : '.'}`);
  }

  const walkedContexts = new Map();
  const walkOnce = (context) => {
    let walked = walkedContexts.get(context);
    if (!walked) {
      walked = walkContext(context);
      walkedContexts.set(context, walked);
    }
    return walked;
  };

  const reports = await Promise.all(builds.map(async (build) => {
    const context = await resolveContext(build.context);
    const walked = await walkOnce(context);
    const dockerfileInput = build.dockerfileText == null
      ? undefined
      : { source: 'dockerfile_inline', text: build.dockerfileText };
    const report = await auditContextInternal(context, build.dockerfile, options, walked, dockerfileInput);
    report.composeTargets = build.composeTargets;
    return report;
  }));

  if (skipped.length > 0 && !ignoredDiagnosticCodes(options).has('compose-context-skipped')) {
    const composeSource = displayPath(projectDirectory, source);
    reports[0].diagnostics.push(...skipped.map(({ target, context }) => ({
      code: 'compose-context-skipped',
      severity: 'info',
      composeTarget: target,
      message: `Compose target ${JSON.stringify(target)} uses a non-local context and was skipped: ${JSON.stringify(context)}.`,
      source: composeSource,
      line: 1,
      column: 1,
    })));
    reports[0].diagnostics.sort(compareDiagnostics);
  }

  return reports.sort((left, right) => compareText(left.composeTargets[0], right.composeTargets[0]));
}

export async function discoverDockerfiles(context = '.') {
  const root = await resolveContext(context);
  const walked = await walkContext(root);
  return discoverDockerfilesFromEntries(walked.entries).map((file) => displayPath(root, file));
}

export function explainPath(report, pathname) {
  const internal = report?.[INTERNAL];
  if (!internal) throw new TypeError('report must come from auditContext() or auditProject().');

  const relative = normalizeContextPath(internal.context, pathname);
  const explanation = evaluateIgnoreRules(internal.rules, relative);
  const rule = explanation.rule
    ? {
      line: explanation.rule.line,
      pattern: explanation.rule.pattern,
      negative: explanation.rule.negative,
      source: report.ignoreFile,
    }
    : null;

  return {
    path: relative,
    ignored: explanation.ignored,
    included: !explanation.ignored || internal.alwaysSent.has(relative),
    rule,
  };
}

async function auditContextInternal(context, dockerfile, options, walked, dockerfileInput) {
  if (dockerfile && !(await isFile(dockerfile))) {
    throw new Error(`Dockerfile not found: ${displayPath(context, dockerfile)}`);
  }

  const diagnostics = [...walked.diagnostics];
  const ignoreFile = await selectIgnoreFile(context, dockerfile);
  const ignoreSource = ignoreFile ? displayPath(context, ignoreFile) : '.dockerignore';
  const ignoreText = ignoreFile ? await readFile(ignoreFile, 'utf8') : '';
  const compiled = compileDockerIgnore(ignoreText, ignoreSource);
  diagnostics.push(...compiled.diagnostics);

  const inactiveAdjacentIgnore = await findInactiveAdjacentIgnore(context, dockerfile, ignoreFile);
  if (inactiveAdjacentIgnore) diagnostics.push(inactiveAdjacentIgnore);

  if (!ignoreFile) {
    diagnostics.push({
      code: 'missing-ignore-file',
      severity: 'warning',
      message: 'No .dockerignore file protects this build context.',
      source: '.dockerignore',
      line: 1,
      column: 1,
    });
  }

  analyzeRuleUsage(compiled.rules, walked.entries);
  for (const rule of compiled.rules) {
    if (rule.effects > 0) continue;
    diagnostics.push({
      code: 'unused-rule',
      severity: 'warning',
      message: `Rule does not change any path in the current context: ${JSON.stringify(rule.pattern)}.`,
      source: ignoreSource,
      line: rule.line,
      column: 1,
    });
  }

  const alwaysSent = new Set(
    [dockerfile, ignoreFile]
      .filter(Boolean)
      .map((file) => relativeIfInside(context, file))
      .filter(Boolean),
  );
  const classifiedEntries = walked.entries.map((entry) => {
    const ignored = compiled.matcher.ignores(entry.path);
    return { ...entry, ignored, included: !ignored || alwaysSent.has(entry.path) };
  });
  const files = classifiedEntries.filter((entry) => entry.type !== 'directory');

  diagnostics.push(...findSensitiveFiles(files));
  diagnostics.push(...findIncludedDirectories(files));

  const stats = buildStats(files);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (Number.isFinite(maxBytes) && stats.includedBytes > maxBytes) {
    diagnostics.push({
      code: 'large-context',
      severity: 'warning',
      message: `Included context is ${formatBytes(stats.includedBytes)}; limit is ${formatBytes(maxBytes)}.`,
    });
  }
  if (Number.isFinite(maxFiles) && stats.includedFiles > maxFiles) {
    diagnostics.push({
      code: 'many-context-files',
      severity: 'warning',
      message: `Included context has ${stats.includedFiles} files; limit is ${maxFiles}.`,
    });
  }

  const dockerfileSource = dockerfile ? displayPath(context, dockerfile) : dockerfileInput?.source ?? null;
  if (dockerfile || dockerfileInput) {
    const dockerfileText = dockerfileInput?.text ?? await readFile(dockerfile, 'utf8');
    diagnostics.push(...checkDockerfile(
      dockerfileText,
      dockerfileSource,
      classifiedEntries,
      compiled.rules,
      alwaysSent,
    ));
  }

  const report = {
    context,
    dockerfile: dockerfileSource,
    ignoreFile: ignoreFile ? displayPath(context, ignoreFile) : null,
    stats,
    rules: compiled.rules.map(({ line, pattern, negative, matches, effects }) => ({
      line,
      pattern,
      negative,
      matches,
      effects,
      used: effects > 0,
    })),
    diagnostics: diagnostics
      .filter(({ code }) => !ignoredDiagnosticCodes(options).has(code))
      .sort(compareDiagnostics),
    files,
  };

  Object.defineProperty(report, INTERNAL, {
    value: { context, rules: compiled.rules, alwaysSent },
    enumerable: false,
  });
  return report;
}

async function findInactiveAdjacentIgnore(context, dockerfile, ignoreFile) {
  if (!dockerfile || path.dirname(dockerfile) === context || ignoreFile === `${dockerfile}.dockerignore`) {
    return null;
  }
  const candidate = path.join(path.dirname(dockerfile), '.dockerignore');
  if (!(await isFile(candidate))) return null;
  const source = displayPath(context, candidate);
  return {
    code: 'inactive-adjacent-ignore-file',
    severity: 'warning',
    message: `${source} is not active for this context; use ${displayPath(context, dockerfile)}.dockerignore or audit its directory as the context.`,
    source,
    line: 1,
    column: 1,
  };
}

function ignoredDiagnosticCodes(options) {
  if (options.ignoreCodes == null) return new Set();
  if (!Array.isArray(options.ignoreCodes) || options.ignoreCodes.some((code) => typeof code !== 'string')) {
    throw new TypeError('ignoreCodes must be an array of diagnostic code strings.');
  }
  return new Set(options.ignoreCodes);
}

async function resolveContext(input = '.') {
  const context = path.resolve(input);
  const stat = await lstat(context).catch((error) => {
    throw new Error(`Build context not found: ${context}`, { cause: error });
  });
  if (!stat.isDirectory()) throw new TypeError(`Build context is not a directory: ${context}`);
  return context;
}

function resolveDockerfile(context, dockerfile) {
  return path.isAbsolute(dockerfile) ? path.resolve(dockerfile) : path.resolve(context, dockerfile);
}

async function defaultDockerfile(context) {
  const candidate = path.join(context, 'Dockerfile');
  return (await isFile(candidate)) ? candidate : undefined;
}

function discoverDockerfilesFromEntries(entries) {
  return entries
    .filter((entry) => {
      if (entry.type !== 'file') return false;
      const segments = entry.path.split('/');
      const basename = segments.at(-1);
      if (segments.some((segment) => segment === '.git' || segment === 'node_modules')) return false;
      return !basename.endsWith('.dockerignore')
        && DOCKERFILE_NAME.test(basename);
    })
    .map((entry) => path.resolve(entry.absolute))
    .sort(compareText);
}

async function selectIgnoreFile(context, dockerfile) {
  if (dockerfile) {
    const specific = `${dockerfile}.dockerignore`;
    if (await isFile(specific)) return specific;
  }
  const root = path.join(context, '.dockerignore');
  return (await isFile(root)) ? root : undefined;
}

function analyzeRuleUsage(rules, entries) {
  const ignored = new Map(entries.map((entry) => [entry.path, false]));

  for (const rule of rules) {
    for (const entry of entries) {
      if (!rule.appliesTo(entry.path)) continue;
      rule.matches += 1;
      const next = !rule.negative;
      if (ignored.get(entry.path) !== next) {
        rule.effects += 1;
        ignored.set(entry.path, next);
      }
    }
  }
}

async function walkContext(context) {
  const entries = [];
  const diagnostics = [];

  async function visit(directory, relativeDirectory = '') {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      diagnostics.push({
        code: 'unreadable-path',
        severity: 'error',
        message: error.message,
        path: relativeDirectory || '.',
      });
      return;
    }

    for await (const dirent of handle) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${dirent.name}`
        : dirent.name;
      const absolute = path.join(directory, dirent.name);
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        diagnostics.push({
          code: 'unreadable-path',
          severity: 'error',
          message: error.message,
          path: relative,
        });
        continue;
      }

      if (stat.isDirectory()) {
        entries.push({ path: relative, absolute, type: 'directory', size: 0 });
        await visit(absolute, relative);
      } else {
        entries.push({
          path: relative,
          absolute,
          type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
          size: stat.size,
        });
      }
    }
  }

  await visit(context);
  entries.sort((left, right) => compareText(left.path, right.path));
  return { entries, diagnostics };
}

function findSensitiveFiles(files) {
  const diagnostics = [];
  let gitReported = false;

  for (const file of files) {
    if (!file.included) continue;
    const lower = file.path.toLowerCase();
    const basename = path.posix.basename(lower);

    if ((lower === '.git' || lower.startsWith('.git/')) && !gitReported) {
      gitReported = true;
      diagnostics.push(sensitive('included-git-history', 'error', '.git history is included in the build context.', file.path));
      continue;
    }

    if (/^\.env(?:\..+)?$/.test(basename) && !/\.(?:example|sample|template)$/.test(basename)) {
      diagnostics.push(sensitive('exposed-env-file', 'error', 'Environment file is included in the build context.', file.path));
    } else if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(basename) || /\.(?:key|p12|pfx|jks|keystore)$/.test(basename)) {
      diagnostics.push(sensitive('exposed-private-key', 'error', 'Private key material is included in the build context.', file.path));
    } else if (/\.pem$/.test(basename)) {
      diagnostics.push(sensitive('exposed-pem-file', 'warning', 'PEM material is included in the build context.', file.path));
    } else if (/^(?:\.npmrc|\.pypirc|\.netrc)$/.test(basename)) {
      diagnostics.push(sensitive('exposed-credential-config', 'warning', 'Credential-bearing config is included in the build context.', file.path));
    } else if (/(?:^|\/)(?:\.aws\/credentials|application_default_credentials\.json|service[-_]?account[^/]*\.json)$/.test(lower)) {
      diagnostics.push(sensitive('exposed-cloud-credentials', 'error', 'Cloud credentials are included in the build context.', file.path));
    } else if (/\.tfstate(?:\.backup)?$/.test(basename)) {
      diagnostics.push(sensitive('exposed-terraform-state', 'error', 'Terraform state is included in the build context.', file.path));
    } else if (/^(?:kubeconfig|\.kubeconfig)$/.test(basename) || lower.endsWith('/.kube/config')) {
      diagnostics.push(sensitive('exposed-kubeconfig', 'error', 'Kubernetes credentials are included in the build context.', file.path));
    }
  }

  return diagnostics;
}

function findIncludedDirectories(files) {
  const directories = [
    ['node_modules', 'included-dependencies', 'node_modules is included in the build context.'],
    ['.venv', 'included-dependencies', '.venv is included in the build context.'],
    ['venv', 'included-dependencies', 'venv is included in the build context.'],
    ['vendor/bundle', 'included-dependencies', 'vendor/bundle is included in the build context.'],
  ];

  return directories.flatMap(([directory, code, message]) => {
    const file = files.find((candidate) =>
      candidate.included && (candidate.path === directory || candidate.path.startsWith(`${directory}/`)));
    return file ? [{ code, severity: 'warning', message, path: directory }] : [];
  });
}

function sensitive(code, severity, message, pathname) {
  return { code, severity, message, path: pathname };
}

function buildStats(files) {
  const included = files.filter((file) => file.included);
  const ignored = files.filter((file) => !file.included);
  const directories = new Map();

  for (const file of included) {
    const directory = file.path.includes('/') ? file.path.split('/')[0] : '.';
    const current = directories.get(directory) ?? { path: directory, files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += file.size;
    directories.set(directory, current);
  }

  return {
    totalFiles: files.length,
    totalBytes: sumBytes(files),
    includedFiles: included.length,
    includedBytes: sumBytes(included),
    ignoredFiles: ignored.length,
    ignoredBytes: sumBytes(ignored),
    largestDirectories: [...directories.values()]
      .sort((left, right) => right.bytes - left.bytes || compareText(left.path, right.path))
      .slice(0, 5),
  };
}

function checkDockerfile(source, sourceName, entries, rules, uncopyablePaths) {
  const diagnostics = [];
  const instructions = dockerfileInstructions(source);

  for (const instruction of instructions) {
    if (instruction.keyword !== 'COPY' && instruction.keyword !== 'ADD') continue;
    const parsed = parseCopyInstruction(instruction.args);
    if (parsed.error) {
      diagnostics.push({
        code: 'dockerfile-syntax',
        severity: 'error',
        message: parsed.error,
        source: sourceName,
        line: instruction.line,
        column: 1,
      });
      continue;
    }
    if (parsed.external) continue;

    if (parsed.excludes.length > 0) {
      diagnostics.push({
        code: 'copy-exclude-unmodeled',
        severity: 'info',
        message: 'COPY --exclude is present; source diagnostics are conservative.',
        source: sourceName,
        line: instruction.line,
        column: 1,
      });
    }

    for (const rawSource of parsed.sources) {
      if (instruction.keyword === 'ADD' && /^(?:https?:|git@|ssh:)/i.test(rawSource)) continue;
      if (/\$/.test(rawSource)) {
        diagnostics.push({
          code: 'dynamic-copy-source',
          severity: 'warning',
          message: `Cannot verify dynamic ${instruction.keyword} source: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
        continue;
      }

      if (/^<<-?/.test(rawSource)) continue;

      const normalized = normalizeCopySource(rawSource);
      let candidates;
      try {
        candidates = copyCandidates(normalized, entries, parsed.parents);
      } catch {
        diagnostics.push({
          code: 'copy-source-pattern-invalid',
          severity: 'error',
          message: `Invalid ${instruction.keyword} source pattern: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
        continue;
      }
      if (normalized === '.' || normalized === '*') {
        diagnostics.push({
          code: 'broad-copy',
          severity: 'warning',
          message: `${instruction.keyword} uses a broad build-context source: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
      }

      if (candidates.length === 0) {
        diagnostics.push({
          code: 'copy-source-missing',
          severity: 'error',
          message: `${instruction.keyword} source does not exist in the build context: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
        continue;
      }

      const copyable = candidates.filter((entry) => !uncopyablePaths.has(entry.path));
      if (copyable.length === 0) {
        diagnostics.push({
          code: 'copy-source-unavailable',
          severity: 'error',
          message: `${instruction.keyword} source is sent for build metadata but cannot be copied: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
        continue;
      }

      const included = copyable.filter((entry) => !entry.ignored);
      if (included.length === 0) {
        const explanation = explainWithRules(rules, candidates[0].path);
        const suffix = explanation.rule
          ? ` Last matching rule: ${JSON.stringify(explanation.rule.pattern)} at line ${explanation.rule.line}.`
          : '';
        diagnostics.push({
          code: 'copy-source-ignored',
          severity: 'error',
          message: `${instruction.keyword} source is excluded by .dockerignore: ${JSON.stringify(rawSource)}.${suffix}`,
          source: sourceName,
          line: instruction.line,
          column: 1,
          path: candidates[0].path,
        });
      } else if (normalized !== '.' && included.length < copyable.length) {
        diagnostics.push({
          code: 'copy-source-partially-ignored',
          severity: 'warning',
          message: `${instruction.keyword} source loses ${copyable.length - included.length} path(s) to .dockerignore: ${JSON.stringify(rawSource)}.`,
          source: sourceName,
          line: instruction.line,
          column: 1,
        });
      }
    }
  }

  return diagnostics;
}

function dockerfileInstructions(source) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let escape = '\\';
  for (const line of lines) {
    const directive = line.match(/^\s*#\s*([A-Za-z][\w-]*)\s*=\s*(.*?)\s*$/);
    if (!directive) break;
    if (directive[1].toLowerCase() === 'escape' && /^[\\`]$/.test(directive[2])) {
      escape = directive[2];
    }
  }

  const instructions = [];
  let buffer = '';
  let startLine = 1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (!buffer) startLine = index + 1;

    const trimmed = line.trimEnd();
    const continued = endsWithUnescaped(trimmed, escape);
    const piece = continued ? trimmed.slice(0, -1) : line;
    buffer += (buffer ? ' ' : '') + piece.trim();
    if (continued) continue;

    const match = buffer.match(/^([A-Za-z]+)\s+([\s\S]*)$/);
    if (match) {
      instructions.push({ keyword: match[1].toUpperCase(), args: match[2], line: startLine });
      for (const heredoc of heredocDelimiters(match[2])) {
        while (index + 1 < lines.length) {
          index += 1;
          const candidate = heredoc.stripTabs ? lines[index].replace(/^\t+/, '') : lines[index];
          if (candidate === heredoc.delimiter) break;
        }
      }
    }
    buffer = '';
  }

  return instructions;
}

function heredocDelimiters(input) {
  return [...input.matchAll(/(?:^|\s)<<(-?)(?:([\x22'])(.*?)\2|([^\s]+))/g)].map((match) => ({
    delimiter: match[3] ?? match[4],
    stripTabs: match[1] === '-',
  }));
}

function parseCopyInstruction(input) {
  let rest = input.trim();
  let external = false;
  let parents = false;
  const excludes = [];

  while (rest.startsWith('--')) {
    const match = rest.match(/^(--[^\s]+)(?:\s+|$)/);
    if (!match) break;
    const option = match[1];
    external ||= option === '--from' || option.startsWith('--from=');
    parents ||= option === '--parents';
    if (option.startsWith('--exclude=')) excludes.push(option.slice('--exclude='.length));
    rest = rest.slice(match[0].length).trimStart();
  }

  let values;
  if (rest.startsWith('[')) {
    try {
      values = JSON.parse(rest);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        return { error: 'COPY/ADD JSON form must be an array of strings.' };
      }
    } catch {
      return { error: 'Invalid COPY/ADD JSON form.' };
    }
  } else {
    values = splitShellWords(rest);
  }

  if (values.length < 2) return { error: 'COPY/ADD requires a source and destination.' };
  return { sources: values.slice(0, -1), destination: values.at(-1), external, excludes, parents };
}

function splitShellWords(input) {
  const words = [];
  let word = '';
  let quote;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += character;
    }
  }

  if (escaped) word += '\\';
  if (word) words.push(word);
  return words;
}

function copyCandidates(source, entries, globstar) {
  if (source === '.') return entries;
  const hasGlob = /[*?[]/.test(source);
  const matchedDirectories = new Set(
    entries
      .filter((entry) => entry.type === 'directory' && matchesCopyPath(entry.path, source, hasGlob, globstar))
      .map((entry) => entry.path),
  );

  return entries.filter((entry) =>
    matchesCopyPath(entry.path, source, hasGlob, globstar)
    || [...matchedDirectories].some((directory) => entry.path.startsWith(`${directory}/`)));
}

function matchesCopyPath(candidate, source, hasGlob, globstar) {
  if (hasGlob) return matchFilePattern(source, candidate, { globstar });
  return candidate === source || candidate.startsWith(`${source}/`);
}

function normalizeCopySource(source) {
  let normalized = source.replaceAll('\\', '/').replace(/^\/+/, '');
  while (normalized.startsWith('../')) normalized = normalized.slice(3);
  normalized = path.posix.normalize(normalized || '.');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function explainWithRules(rules, pathname) {
  return evaluateIgnoreRules(rules, pathname);
}

function endsWithUnescaped(value, character) {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === character; index -= 1) count += 1;
  return count % 2 === 1;
}

function normalizeContextPath(context, input) {
  let relative;
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    relative = path.relative(context, path.resolve(input));
    if (path.isAbsolute(relative)) throw new RangeError('Path is outside the build context.');
  } else {
    relative = input.replaceAll('\\', '/').replace(/^\/+/, '');
  }

  relative = relative.split(path.sep).join('/');
  relative = path.posix.normalize(relative || '.');
  if (relative === '..' || relative.startsWith('../')) {
    throw new RangeError('Path is outside the build context.');
  }
  return relative.startsWith('./') ? relative.slice(2) : relative;
}

function relativeIfInside(context, file) {
  const relative = path.relative(context, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function displayPath(context, file) {
  return relativeIfInside(context, file) ?? file;
}

async function isFile(file) {
  return lstat(file).then((stat) => stat.isFile(), () => false);
}

function sumBytes(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function compareDiagnostics(left, right) {
  return (SEVERITY_ORDER[left.severity] ?? 3) - (SEVERITY_ORDER[right.severity] ?? 3)
    || compareText(String(left.source ?? left.path ?? ''), String(right.source ?? right.path ?? ''))
    || (left.line ?? 0) - (right.line ?? 0)
    || compareText(left.code, right.code);
}
