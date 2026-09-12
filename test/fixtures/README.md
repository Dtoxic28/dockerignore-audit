# Independent validation fixtures

## SARIF schema

`sarif-schema-2.1.0.json`: unmodified OASIS SARIF 2.1.0 errata01 JSON Schema, draft-04.

- Source: https://raw.githubusercontent.com/oasis-tcs/sarif-spec/a560296ca8c921f3bdb8d4a8db57ab83dae968a7/sarif-2.1/schema/sarif-schema-2.1.0.json
- SHA-256: c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e
- Validation: Ajv draft-04 plus URI format checks; development dependencies only.
- Tests validate generated reports and deliberately corrupt a URI/region to prove rejection.

## Matcher differential corpus

`matcher-win32.json` and `matcher-posix.json` store 10,025 outcomes per platform,
for the seeded inputs in `scripts/matcher-cases.js`. `-1` means invalid pattern,
`0` means no match, `1` means match. The JavaScript implementation never generates
expected results.

Oracle: `matcher-oracle/main.go`, Go `path.Match` for POSIX COPY globs,
Moby `ignorefile.ReadAll` + `patternmatcher` v0.6.1 for native ignore semantics.
Moby checksum is pinned in `go.sum`. Every ignore rule is compiled independently
before evaluation because the auditor diagnoses invalid rules eagerly, even when
negation ordering would make a rule unreachable. The oracle does not implement
its own matching algorithm. Recursive COPY `--parents` is not covered by this oracle.

Generated with Go 1.27.1. Windows outcomes used the native Go executable;
POSIX outcomes used the same Go program compiled for `GOOS=js GOARCH=wasm`.
CI verifies both corpora against native Go on Windows and Linux.

```sh
npm run test:oracle       # Go installed; verifies, never rewrites
npm run test:differential # offline; compares JavaScript to saved oracle results
# Intentionally regenerate only after inspecting an upstream or corpus change:
node scripts/matcher-oracle.js --update
```

The WASM regeneration path accepts `MATCHER_ORACLE_WASM`,
`MATCHER_ORACLE_WASM_RUNNER` (Go's `wasm_exec_node.js`),
`MATCHER_ORACLE_PLATFORM=posix`. These affect only the oracle development script.
