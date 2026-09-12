# Changelog

## 0.4.1 - 2026-09-12

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