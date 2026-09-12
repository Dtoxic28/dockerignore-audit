# Changelog

## 0.4.1 - 2026-09-12

- Compare 10,025 seeded matcher cases per platform with pinned Go/Moby oracles.
- Fix literal closing brackets, strict end anchors, POSIX backslashes, and globstar control characters.
- Bound Compose config execution; preserve subprocess causes and validate malformed results.
- Require Node 22.1+ for native cross-platform file URL conversion.
- Validate SARIF with the OASIS schema; fix cross-drive, UNC, POSIX and normalized URI paths.
- Run Windows/Linux CI with native oracle verification and development-only schema validators.

- Validate public size/file limits and reject unsafe CLI byte values.
- Add an explicit Docker conformance command with local skip and CI-required modes.
- Report unterminated quoted COPY/ADD sources as Dockerfile syntax errors.
- Add deterministic matcher fuzz coverage, Compose edge-case coverage, and portable SARIF URI paths.

## 0.4.0 — 2026-09-12

- Added deterministic SARIF 2.1.0 output with locations and fingerprints.
- Added JSON baseline suppression for unchanged diagnostics.
- Added GitHub Action inputs for `baseline` and `sarif`.
- Parallelized independent Compose context audits while deduplicating in-flight walks.
- Added npm release workflow and expanded CLI regression coverage.