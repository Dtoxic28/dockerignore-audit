# dockerignore-audit

[![CI](https://github.com/Dtoxic28/dockerignore-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/Dtoxic28/dockerignore-audit/actions/workflows/ci.yml)

Audit files eligible for Docker build contexts. Uses current `.dockerignore` matching, reports exposed secrets and oversized contexts, explains the deciding rule, checks local `COPY`/`ADD` sources, and emits CI-native annotations.

## Why

`.dockerignore` is not `.gitignore`. Negation order, `**`, context roots, and Dockerfile-specific ignore files can silently expose credentials, dependency trees, or Git history to a builder. Existing Dockerfile linters inspect instructions; this tool audits context eligibility and complements tools such as Hadolint.

## Install

```sh
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 .
```

Requires Node.js 22 or newer. Docker is not required.

The npm package is not published yet. The command above installs the tagged, zero-runtime-dependency release directly from this public GitHub repository.

## Usage

```text
dockerignore-audit [CONTEXT] [options]

Options:
  -f, --dockerfile FILE  Audit one Dockerfile instead of auto-discovery
      --explain PATH     Show the last rule deciding one path
      --json             Emit machine-readable JSON
      --github           Emit GitHub Actions annotations
      --list MODE        List included, ignored, or all context files
      --ignore CODE      Suppress one diagnostic code; repeatable
      --fail-on LEVEL    Exit 1 on error, warning, or info (default: error)
      --max-bytes SIZE   Warn above included context size (default: 100MiB)
      --max-files COUNT  Warn above included file count (default: 10000)
  -h, --help             Show help
```

Examples:

```sh
# Audit every discovered Dockerfile
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 .

# Audit one build definition
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 . -f docker/release.Dockerfile

# Explain inclusion or exclusion
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 . --explain .env

# CI output and warning threshold
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 . --json --fail-on warning

# Inspect exactly which paths are eligible or ignored
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 . --list included

# Suppress a known diagnostic without hiding other warnings
npx --yes github:Dtoxic28/dockerignore-audit#v0.2.0 . --ignore unused-rule --fail-on warning
```

Exit codes: `0` clean, `1` configured severity reached, `2` usage or runtime error.

## GitHub Actions

```yaml
- uses: Dtoxic28/dockerignore-audit@v0.2.0
  with:
    context: .
    fail-on: warning
    ignore: unused-rule
```

The action runs directly from the tagged repository with no npm install or runtime dependencies. The CLI's `--github` option emits the same native error, warning, and notice annotations. Pin the full release commit instead of the mutable tag when your threat model requires immutable third-party code.

## Context Root

The positional argument is always the build-context root. Docker resolves `.dockerignore` and local `COPY`/`ADD` sources from that directory, not from the Dockerfile directory.

```sh
# Equivalent context intent: docker build -f services/api/Dockerfile .
dockerignore-audit . -f services/api/Dockerfile

# Equivalent context intent: docker build services/api
dockerignore-audit services/api
```

When a nested Dockerfile has a nearby but inactive `.dockerignore`, the audit reports `inactive-adjacent-ignore-file` with the two valid fixes.

## Checks

- Dockerfile-specific `<Dockerfile>.dockerignore` precedence over root `.dockerignore`.
- Secret-prone paths: env files, private keys, cloud credentials, Terraform state, kubeconfig, npm/Python credential files, Git history.
- Included dependency trees such as `node_modules` and virtual environments.
- Included file count, byte size, ignored savings, largest top-level directories.
- Rules that never change a path in the current context.
- Inactive nested `.dockerignore` files beside Dockerfiles using a different context root.
- Missing, fully ignored, partially ignored, broad, dynamic, heredoc, and `--parents` local `COPY`/`ADD` sources.
- Human-readable inventory, stable JSON, GitHub annotations, deterministic diagnostics, suppressions, and CI failure thresholds.

Sensitive-file checks are name-based. File contents are never read for secret detection.

## API

```js
import { auditContext, auditProject, explainPath } from 'dockerignore-audit';

const report = await auditContext({
  context: '.',
  dockerfile: 'Dockerfile',
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 5_000,
  ignoreCodes: ['unused-rule'],
});

console.log(report.stats);
console.log(report.diagnostics);
console.log(explainPath(report, '.env'));

const everyBuild = await auditProject({ context: '.' });
```

TypeScript declarations ship with the package. The public report includes context files, rule effects, aggregate statistics, and diagnostics. JSON always includes the complete file inventory; `--list` controls only human-readable output.

## Semantics

- Matching is implemented locally with zero runtime dependencies and regression cases derived from current [`moby/patternmatcher`](https://github.com/moby/patternmatcher) behavior.
- Paths are evaluated relative to the build-context root.
- A Dockerfile-specific ignore file wins when present, matching Docker's documented precedence.
- Dockerfile and active ignore files remain counted as sent even when a rule matches them; Docker sends these files for the build but does not make them copyable.
- `included` means eligible under ignore rules. BuildKit may transfer eligible data lazily, so it does not promise that every byte crossed the wire.
- Normal `COPY`/`ADD` wildcards follow Go `filepath.Match`; recursive `**` source matching is enabled only with `COPY --parents`.
- External `COPY --from=...` sources and remote `ADD` sources are outside context auditing.
- `COPY --exclude` and advanced BuildKit forms produce conservative diagnostics rather than simulated execution.

## Development

```sh
npm ci
npm run check
```

Tests use Node's built-in test runner. Local development needs no Docker daemon, test framework, build step, or generated source. CI additionally compares representative reports with a real Docker BuildKit build.

## References

- [Docker build context and `.dockerignore`](https://docs.docker.com/build/building/context/)
- [Dockerfile `COPY`](https://docs.docker.com/reference/dockerfile/#copy)
- [Moby `.dockerignore` issue collection](https://github.com/moby/moby/issues/40319)
- [Moby pattern matcher](https://github.com/moby/patternmatcher)

## License

MIT
