import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function applyBaseline(reports, filename) {
  const entries = await readBaseline(filename);
  const baselineRoot = path.dirname(path.resolve(filename));
  const known = new Set(entries.flatMap((report) =>
    (report.diagnostics ?? []).map((diagnostic) => diagnosticKey(report, diagnostic, baselineRoot))));

  return reports.map((report) => {
    const diagnostics = report.diagnostics.filter((diagnostic) => !known.has(diagnosticKey(report, diagnostic, baselineRoot)));
    const baselineSuppressed = report.diagnostics.length - diagnostics.length;
    return baselineSuppressed === 0
      ? report
      : { ...report, diagnostics, baselineSuppressed };
  });
}

async function readBaseline(filename) {
  let text;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    throw new Error(`Baseline file could not be read: ${filename}`, { cause: error });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Baseline file is not valid JSON: ${filename}`, { cause: error });
  }
  const reports = Array.isArray(value) ? value : value?.reports;
  if (!Array.isArray(reports) || reports.some((report) => !report || !Array.isArray(report.diagnostics))) {
    throw new TypeError('Baseline JSON must be an audit report array or an object with a reports array.');
  }
  return reports;
}

function diagnosticKey(report, diagnostic, baselineRoot) {
  return [
    contextKey(report.context, baselineRoot),
    report.dockerfile ?? '',
    report.composeTargets?.join(',') ?? '',
    diagnostic.code ?? '',
    diagnostic.source ?? diagnostic.path ?? '',
    diagnostic.line ?? '',
    diagnostic.column ?? '',
    diagnostic.message ?? '',
  ].join('\0');
}
function contextKey(context, baselineRoot) {
  const relative = path.relative(baselineRoot, context).replaceAll('\\', '/');
  return relative && relative !== '..' && !relative.startsWith('../') ? relative : path.basename(context);
}
