import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const REPOSITORY = 'https://github.com/Dtoxic28/dockerignore-audit';

export function toSarif(reports) {
  if (!Array.isArray(reports)) throw new TypeError('reports must be an array.');

  const ruleMessages = new Map();
  const results = [];
  for (const report of reports) {
    if (!Array.isArray(report?.diagnostics)) throw new TypeError('reports must contain diagnostics arrays.');
    for (const diagnostic of report.diagnostics) {
      const ruleId = String(diagnostic.code);
      if (!ruleMessages.has(ruleId)) ruleMessages.set(ruleId, diagnostic.message);

      const result = {
        ruleId,
        level: sarifLevel(diagnostic.severity),
        message: { text: diagnostic.message },
      };
      const location = diagnosticLocation(report, diagnostic);
      if (location) result.locations = [location];
      if (diagnostic.composeTarget) result.properties = { composeTarget: diagnostic.composeTarget };
      result.partialFingerprints = {
        primaryLocationLineHash: fingerprint(report, diagnostic),
      };
      results.push(result);
    }
  }

  results.sort(compareResults);
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'dockerignore-audit',
          informationUri: REPOSITORY,
          rules: [...ruleMessages.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, message]) => ({
              id,
              name: id,
              shortDescription: { text: id },
              fullDescription: { text: message },
            })),
        },
      },
      results,
    }],
  };
}

function sarifLevel(severity) {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'note';
}

function diagnosticLocation(report, diagnostic) {
  const value = diagnostic.source ?? diagnostic.path;
  if (!value) return undefined;
  const uri = relativeArtifactPath(report.context, value);
  const physicalLocation = { artifactLocation: { uri } };
  if (Number.isInteger(diagnostic.line) && diagnostic.line > 0) {
    physicalLocation.region = { startLine: diagnostic.line };
    if (Number.isInteger(diagnostic.column) && diagnostic.column > 0) {
      physicalLocation.region.startColumn = diagnostic.column;
    }
  }
  return { physicalLocation };
}

function relativeArtifactPath(context, value) {
  const raw = String(value).replaceAll('\\', '/');
  if (!path.posix.isAbsolute(raw) && !isWindowsAbsolute(raw)) {
    return encodeUriPath(path.posix.normalize(raw));
  }

  const root = String(context).replaceAll('\\', '/');
  const windows = isWindowsAbsolute(raw);
  const pathApi = windows ? path.win32 : path.posix;
  // Resolve using the input's syntax, never the machine producing the SARIF.
  if (windows === isWindowsAbsolute(root) && pathApi.isAbsolute(root)) {
    const relative = pathApi.relative(root, raw).replaceAll('\\', '/');
    if (relative && relative !== '..' && !relative.startsWith('../') && !pathApi.isAbsolute(relative)) {
      return encodeUriPath(relative);
    }
  }

  return pathToFileURL(pathApi.normalize(raw), { windows }).href;
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('//');
}

function encodeUriPath(value) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function fingerprint(report, diagnostic) {
  const identity = [
    report.context,
    report.dockerfile ?? '',
    report.composeTargets?.join(',') ?? '',
    diagnostic.code,
    diagnostic.source ?? diagnostic.path ?? '',
    diagnostic.line ?? '',
    diagnostic.column ?? '',
    diagnostic.message,
  ].join('\0');
  return createHash('sha256').update(identity).digest('hex');
}

function compareResults(left, right) {
  return left.ruleId.localeCompare(right.ruleId)
    || String(left.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '')
      .localeCompare(String(right.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? ''))
    || (left.locations?.[0]?.physicalLocation?.region?.startLine ?? 0)
      - (right.locations?.[0]?.physicalLocation?.region?.startLine ?? 0)
    || left.message.text.localeCompare(right.message.text);
}