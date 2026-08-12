# dockerignore-audit

[![CI](https://github.com/Dtoxic28/dockerignore-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/Dtoxic28/dockerignore-audit/actions/workflows/ci.yml)

Audit the files Docker receives before a build. Uses Docker-compatible `.dockerignore` matching, reports exposed secrets and oversized contexts, explains the deciding rule, and checks local `COPY`/`ADD` sources.

## Why

`.dockerignore` is not `.gitignore`. Negation order, `**`, context roots, and Dockerfile-specific ignore files can silently send credentials, dependency trees, or Git history to a builder. Existing Dockerfile linters inspect instructions; this tool audits the build context itself.

## Install

```sh
npx dockerignore-audit .
```

Requires Node.js 22 or newer. Docker is not required.

## Usage

```text
dockerignore-audit [CONTEXT] [options]

Options:
  -f, --dockerfile FILE  Audit one Dockerfile instead of auto-discovery
      --explain PATH     Show the last rule deciding one path
      --json             Emit machine-readable JSON
      --fail-on LEVEL    Exit 1 on error, warning, or info (default: error)
      --max-bytes SIZE   Warn above included context size (default: 100MiB)
      --max-files COUNT  Warn above included file count (default: 10000)
  -h, --help             Show help
```

Examples:

```sh
# Audit every discovered Dockerfile
npx dockerignore-audit .

# Audit one build definition
npx dockerignore-audit . -f docker/release.Dockerfile

# Explain inclusion or exclusion
npx dockerignore-audit . --explain .env

# CI output and warning threshold
npx dockerignore-audit . --json --fail-on warning
```

Exit codes: `0` clean, `1` configured severity reached, `2` usage or runtime error.

## Checks

- Dockerfile-specific `<Dockerfile>.dockerignore` precedence over root `.dockerignore`.
- Secret-prone paths: env files, private keys, cloud credentials, Terraform state, kubeconfig, npm/Python credential files, Git history.
- Included dependency trees such as `node_modules` and virtual environments.
- Included file count, byte size, ignored savings, largest top-level directories.
- Rules that never change a path in the current context.
- Missing, fully ignored, partially ignored, broad, or dynamic local `COPY`/`ADD` sources.
- Human-readable output, stable JSON, deterministic diagnostics, CI failure thresholds.

Sensitive-file checks are name-based. File contents are never read for secret detection.

## API

```js
import { auditContext, auditProject, explainPath } from 'dockerignore-audit';

const report = await auditContext({
  context: '.',
  dockerfile: 'Dockerfile',
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 5_000,
});

console.log(report.stats);
console.log(report.diagnostics);
console.log(explainPath(report, '.env'));

const everyBuild = await auditProject({ context: '.' });
```

TypeScript declarations ship with the package. The public report includes context files, rule effects, aggregate statistics, and diagnostics.

## Semantics

- Matching delegates to [`@balena/dockerignore`](https://github.com/balena-io-modules/dockerignore), a zero-dependency JavaScript port tested against Docker behavior. Matching is case-sensitive, matching Docker.
- Paths are evaluated relative to the build-context root.
- A Dockerfile-specific ignore file wins when present, matching Docker's documented precedence.
- Dockerfile and active ignore files remain counted as sent even when a rule matches them; Docker sends these files for the build but does not make them copyable.
- External `COPY --from=...` sources and remote `ADD` sources are outside context auditing.
- `COPY --exclude` and advanced BuildKit forms produce conservative diagnostics rather than simulated execution.

## Development

```sh
npm ci
npm run check
```

Tests use Node's built-in test runner. No Docker daemon, test framework, build step, or generated source is required.

## References

- [Docker build context and `.dockerignore`](https://docs.docker.com/build/building/context/)
- [Dockerfile `COPY`](https://docs.docker.com/reference/dockerfile/#copy)
- [Moby `.dockerignore` issue collection](https://github.com/moby/moby/issues/40319)
- [`@balena/dockerignore`](https://github.com/balena-io-modules/dockerignore)

## License

MIT
