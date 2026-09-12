#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applyBaseline } from './baseline.js';
import { auditCompose, auditProject, explainPath } from './index.js';
import { toSarif } from './sarif.js';

const LEVELS = { error: 0, warning: 1, info: 2 };

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    process.exit(0);
  }

  const reports = options.composeFiles.length > 0
    ? await auditCompose(options)
    : await auditProject(options);
  if (options.explain) {
    const explanations = reports.map((report) => ({
      dockerfile: report.dockerfile,
      composeTargets: report.composeTargets,
      ignoreFile: report.ignoreFile,
      ...explainPath(report, options.explain),
    }));
    process.stdout.write(options.json
      ? `${JSON.stringify(explanations, null, 2)}\n`
      : explanations.map(formatExplanation).join('\n'));
    process.exit(0);
  }

  const outputReports = options.baseline
    ? await applyBaseline(reports, options.baseline)
    : reports;
  if (options.sarif) {
    await writeFile(path.resolve(options.sarif), `${JSON.stringify(toSarif(outputReports), null, 2)}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outputReports.map(publicReport), null, 2)}\n`);
  } else if (options.github) {
    process.stdout.write(formatGitHub(outputReports));
  } else {
    process.stdout.write(outputReports.map((report) => formatReport(report, options.list)).join('\n'));
  }

  const threshold = LEVELS[options.failOn];
  process.exitCode = outputReports.some((report) =>
    report.diagnostics.some((diagnostic) => LEVELS[diagnostic.severity] <= threshold)) ? 1 : 0;
} catch (error) {
  process.stderr.write(`dockerignore-audit: ${error.message}\n`);
  process.exitCode = 2;
}

function parseArguments(args) {
  const options = {
    context: '.',
    dockerfile: undefined,
    composeFiles: [],
    explain: undefined,
    json: false,
    github: false,
    list: undefined,
    ignoreCodes: [],
    failOn: 'error',
    maxBytes: undefined,
    maxFiles: undefined,
    baseline: undefined,
    sarif: undefined,
    help: false,
  };
  let contextSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--github') options.github = true;
    else if (argument === '--list') options.list = parseListMode(requiredValue(args, ++index, argument));
    else if (argument === '--ignore') options.ignoreCodes.push(parseDiagnosticCode(requiredValue(args, ++index, argument)));
    else if (argument === '--compose') options.composeFiles.push(requiredValue(args, ++index, argument));
    else if (argument === '--dockerfile' || argument === '-f') options.dockerfile = requiredValue(args, ++index, argument);
    else if (argument === '--explain') options.explain = requiredValue(args, ++index, argument);
    else if (argument === '--fail-on') options.failOn = parseLevel(requiredValue(args, ++index, argument));
    else if (argument === '--max-bytes') options.maxBytes = parseBytes(requiredValue(args, ++index, argument));
    else if (argument === '--max-files') options.maxFiles = parseCount(requiredValue(args, ++index, argument), argument);
    else if (argument === '--baseline') options.baseline = requiredValue(args, ++index, argument);
    else if (argument === '--sarif') options.sarif = requiredValue(args, ++index, argument);
    else if (argument.startsWith('-')) throw new TypeError(`Unknown option: ${argument}`);
    else if (contextSet) throw new TypeError(`Unexpected argument: ${argument}`);
    else {
      options.context = argument;
      contextSet = true;
    }
  }

  if (options.json && options.github) throw new TypeError('--json and --github cannot be combined.');
  if (options.composeFiles.length > 0 && options.dockerfile) {
    throw new TypeError('--compose and --dockerfile cannot be combined.');
  }
  if (options.explain && options.github) throw new TypeError('--explain and --github cannot be combined.');
  if (options.explain && options.sarif) throw new TypeError('--explain and --sarif cannot be combined.');
  if (options.list && (options.json || options.github || options.explain)) {
    throw new TypeError('--list only supports human-readable audit output.');
  }

  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (value == null || value.startsWith('--')) throw new TypeError(`${option} requires a value.`);
  return value;
}

function parseLevel(value) {
  if (!Object.hasOwn(LEVELS, value)) throw new TypeError('--fail-on must be error, warning, or info.');
  return value;
}

function parseListMode(value) {
  if (!['included', 'ignored', 'all'].includes(value)) {
    throw new TypeError('--list must be included, ignored, or all.');
  }
  return value;
}

function parseDiagnosticCode(value) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError('--ignore requires a diagnostic code.');
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

function formatReport(report, listMode) {
  const target = reportTarget(report);
  const ignore = report.ignoreFile ?? '(no ignore file)';
  const lines = [
    `${target}  ignore=${ignore}`,
    `context: ${report.stats.includedFiles}/${report.stats.totalFiles} files, ${formatBytes(report.stats.includedBytes)}/${formatBytes(report.stats.totalBytes)} included`,
  ];
  if (report.baselineSuppressed) lines.push(`baseline: ${report.baselineSuppressed} unchanged diagnostic(s) suppressed`);

  if (listMode) {
    const files = report.files.filter((file) =>
      listMode === 'all' || file.included === (listMode === 'included'));
    lines.push(`${listMode} files (${files.length}):`);
    for (const file of files) {
      const state = listMode === 'all' ? `${file.included ? 'INCLUDED' : 'IGNORED'} ` : '';
      lines.push(`  ${state}${formatBytes(file.size).padStart(9)} ${file.path}`);
    }
  }

  for (const diagnostic of report.diagnostics) {
    const location = diagnostic.source
      ? ` ${diagnostic.source}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}`
      : diagnostic.path ? ` ${diagnostic.path}` : '';
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location} - ${diagnostic.message}`);
  }

  const counts = Object.fromEntries(Object.keys(LEVELS).map((level) => [level, 0]));
  for (const diagnostic of report.diagnostics) counts[diagnostic.severity] += 1;
  lines.push(`result: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`, '');
  return lines.join('\n');
}

function formatGitHub(reports) {
  const lines = [];
  const counts = Object.fromEntries(Object.keys(LEVELS).map((level) => [level, 0]));

  for (const report of reports) {
    for (const diagnostic of report.diagnostics) {
      const target = diagnostic.composeTarget ?? reportTarget(report);
      counts[diagnostic.severity] += 1;
      const command = diagnostic.severity === 'info' ? 'notice' : diagnostic.severity;
      const properties = { title: `dockerignore-audit/${diagnostic.code}` };
      const file = diagnostic.source ?? diagnostic.path;
      if (file) {
        properties.file = file;
        properties.line = diagnostic.line ?? 1;
        properties.col = diagnostic.column ?? 1;
      }
      const metadata = Object.entries(properties)
        .map(([key, value]) => `${key}=${escapeWorkflowProperty(value)}`)
        .join(',');
      lines.push(`::${command} ${metadata}::${escapeWorkflowData(`${diagnostic.message} [${target}]`)}`);
    }
  }

  lines.push(`dockerignore-audit: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`);
  return `${lines.join('\n')}\n`;
}

function escapeWorkflowData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function formatExplanation(explanation) {
  const target = reportTarget(explanation);
  const state = explanation.included ? 'included' : 'ignored';
  const rule = explanation.rule
    ? `${explanation.rule.source}:${explanation.rule.line} ${JSON.stringify(explanation.rule.pattern)}`
    : 'no matching rule';
  return `${target}: ${explanation.path} is ${state}; ${rule}\n`;
}

function reportTarget(report) {
  const dockerfile = report.dockerfile ?? '(no Dockerfile)';
  return report.composeTargets?.length
    ? `${report.composeTargets.join(', ')} (${dockerfile})`
    : dockerfile;
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

Audit files eligible for Docker build contexts using current ignore semantics.

Options:
  -f, --dockerfile FILE  Audit one Dockerfile instead of auto-discovery
      --compose FILE     Audit Compose build contexts; repeatable for overlays
      --explain PATH     Show the last rule deciding one path
      --json             Emit machine-readable JSON
      --github           Emit GitHub Actions annotations
      --list MODE        List included, ignored, or all context files
      --ignore CODE      Suppress one diagnostic code; repeatable
      --fail-on LEVEL    Exit 1 on error, warning, or info (default: error)
      --max-bytes SIZE   Warn above included context size (default: 100MiB)
      --max-files COUNT  Warn above included file count (default: 10000)
      --baseline FILE    Suppress diagnostics already present in a JSON baseline
      --sarif FILE       Write SARIF 2.1.0 results to FILE
  -h, --help             Show help

Exit codes: 0 clean, 1 threshold reached, 2 usage or runtime error.
`;
}
