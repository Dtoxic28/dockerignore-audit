#!/usr/bin/env node

import process from 'node:process';
import { auditProject, explainPath } from './index.js';

const LEVELS = { error: 0, warning: 1, info: 2 };

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    process.exit(0);
  }

  const reports = await auditProject(options);
  if (options.explain) {
    const explanations = reports.map((report) => ({
      dockerfile: report.dockerfile,
      ignoreFile: report.ignoreFile,
      ...explainPath(report, options.explain),
    }));
    process.stdout.write(options.json
      ? `${JSON.stringify(explanations, null, 2)}\n`
      : explanations.map(formatExplanation).join('\n'));
    process.exit(0);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports.map(publicReport), null, 2)}\n`);
  } else {
    process.stdout.write(reports.map(formatReport).join('\n'));
  }

  const threshold = LEVELS[options.failOn];
  process.exitCode = reports.some((report) =>
    report.diagnostics.some((diagnostic) => LEVELS[diagnostic.severity] <= threshold)) ? 1 : 0;
} catch (error) {
  process.stderr.write(`dockerignore-audit: ${error.message}\n`);
  process.exitCode = 2;
}

function parseArguments(args) {
  const options = {
    context: '.',
    dockerfile: undefined,
    explain: undefined,
    json: false,
    failOn: 'error',
    maxBytes: undefined,
    maxFiles: undefined,
    help: false,
  };
  let contextSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--dockerfile' || argument === '-f') options.dockerfile = requiredValue(args, ++index, argument);
    else if (argument === '--explain') options.explain = requiredValue(args, ++index, argument);
    else if (argument === '--fail-on') options.failOn = parseLevel(requiredValue(args, ++index, argument));
    else if (argument === '--max-bytes') options.maxBytes = parseBytes(requiredValue(args, ++index, argument));
    else if (argument === '--max-files') options.maxFiles = parseCount(requiredValue(args, ++index, argument), argument);
    else if (argument.startsWith('-')) throw new TypeError(`Unknown option: ${argument}`);
    else if (contextSet) throw new TypeError(`Unexpected argument: ${argument}`);
    else {
      options.context = argument;
      contextSet = true;
    }
  }

  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (value == null || value.startsWith('--')) throw new TypeError(`${option} requires a value.`);
  return value;
}

function parseLevel(value) {
  if (!(value in LEVELS)) throw new TypeError('--fail-on must be error, warning, or info.');
  return value;
}

function parseCount(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${option} must be a non-negative integer.`);
  return number;
}

function parseBytes(value) {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB)?$/i);
  if (!match) throw new TypeError('--max-bytes must look like 500KB, 20MiB, or 1GB.');
  const units = { B: 1, KB: 1_000, KIB: 1024, MB: 1_000_000, MIB: 1024 ** 2, GB: 1_000_000_000, GIB: 1024 ** 3 };
  return Math.round(Number(match[1]) * units[(match[2] ?? 'B').toUpperCase()]);
}

function publicReport(report) {
  return {
    ...report,
    files: report.files.map(({ absolute, ...file }) => file),
  };
}

function formatReport(report) {
  const target = report.dockerfile ?? '(no Dockerfile)';
  const ignore = report.ignoreFile ?? '(no ignore file)';
  const lines = [
    `${target}  ignore=${ignore}`,
    `context: ${report.stats.includedFiles}/${report.stats.totalFiles} files, ${formatBytes(report.stats.includedBytes)}/${formatBytes(report.stats.totalBytes)} included`,
  ];

  for (const diagnostic of report.diagnostics) {
    const location = diagnostic.source
      ? ` ${diagnostic.source}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}`
      : diagnostic.path ? ` ${diagnostic.path}` : '';
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location} — ${diagnostic.message}`);
  }

  const counts = Object.fromEntries(Object.keys(LEVELS).map((level) => [level, 0]));
  for (const diagnostic of report.diagnostics) counts[diagnostic.severity] += 1;
  lines.push(`result: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`, '');
  return lines.join('\n');
}

function formatExplanation(explanation) {
  const target = explanation.dockerfile ?? '(no Dockerfile)';
  const state = explanation.included ? 'included' : 'ignored';
  const rule = explanation.rule
    ? `${explanation.rule.source}:${explanation.rule.line} ${JSON.stringify(explanation.rule.pattern)}`
    : 'no matching rule';
  return `${target}: ${explanation.path} is ${state}; ${rule}\n`;
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

function helpText() {
  return `dockerignore-audit [CONTEXT] [options]

Audit files sent to Docker builds using Docker-compatible ignore semantics.

Options:
  -f, --dockerfile FILE  Audit one Dockerfile instead of auto-discovery
      --explain PATH     Show the last rule deciding one path
      --json             Emit machine-readable JSON
      --fail-on LEVEL    Exit 1 on error, warning, or info (default: error)
      --max-bytes SIZE   Warn above included context size (default: 100MiB)
      --max-files COUNT  Warn above included file count (default: 10000)
  -h, --help             Show help

Exit codes: 0 clean, 1 threshold reached, 2 usage or runtime error.
`;
}
