# Changelog

## 0.4.0 — 2026-09-12

- Added deterministic SARIF 2.1.0 output with locations and fingerprints.
- Added JSON baseline suppression for unchanged diagnostics.
- Added GitHub Action inputs for `baseline` and `sarif`.
- Parallelized independent Compose context audits while deduplicating in-flight walks.
- Added npm release workflow and expanded CLI regression coverage.