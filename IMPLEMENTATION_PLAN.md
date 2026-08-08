# Implementation Plan

Status: Phases 0, 1, and 2 complete; Phase 3 not started
Last updated: 2026-08-08

## Working model

- The supervisor owns scope, gates, coordination documents, and merge decisions.
- Audit and verification agents are read-only.
- An implementation agent receives one bounded code area at a time only after the relevant gate passes.
- No agent approves or merges its own work.
- Tests, committed vectors, production builds, and independent review determine completion.
- Application behavior remains unchanged until the upstream audit and compatibility specification pass review.

## Phase 0: upstream baseline

Deliverables:

- Fork and protected-main topology.
- Exact upstream commit and environment inventory.
- Full trace of both BIP39 mechanisms and their production reachability.
- Clean install, test, type-check, web build, and Electron build results.
- At least five fixed synthetic wallet-output baselines, checked across all four rotations.
- `UPSTREAM_AUDIT.md` with failures recorded rather than repaired.

Gate: the current wallet output is reproducible, rotation behavior is measured, build failures are documented, and no application source has changed.

## Phase 1: freeze `DK-BIP39-24-v1`

Deliverables:

- Complete implementation-independent specification.
- At least 20 committed public synthetic vectors.
- Minimal Python reference implementation independent of the app's TypeScript.
- TypeScript, upstream WASM, and Python parity.
- Written disposition for the reversible layout codec.

Gate: an independent reviewer can reproduce the algorithm from the specification alone and all implementations agree.

## Phase 2: build and dependency foundation

Deliverables: credential-free bootstrap/check/release commands, pinned public-source package recipes, supported runtime pinning, offline rebuild after acquisition, checksums, license inventory, normalized SBOM, and clearly unsigned host-platform evaluation artifacts.

Gate: a fresh machine can clone, bootstrap, test, and build without private package credentials; a second run succeeds from acquired caches with networking denied; the generated provenance identifies every unresolved release blocker and sets `releaseEligible` to false.

Result: passed independent review. A clean Linux/amd64 environment acquired every input without private credentials, ran all checks, and produced the unsigned evidence set. A separate Docker network namespace with no default route and direct HTTPS failing `ENETUNREACH` replayed bootstrap, all 13 Jest suites/1,696 tests, and the complete build from cache. The 14 checksum-bound evidence files matched the online run, and provenance recorded `dirty=false`, `releaseEligible=false`, and `acquisitionMode=cache-enforced-replay`.

Phase 2 does not authorize public distribution. Repository/scanner licensing, reproducible WASM toolchains, content verification for native keytar inputs, an Electron upgrade, entitlement minimization, and signed fail-closed release infrastructure remain later release gates. See D-013 through D-017 in `DECISIONS.md`.

## Phase 3: isolated derivation module

Deliverables: a narrowly scoped `DiceKeyBip39ProfileV1` module, exact-recipe regression tests, committed-vector tests, rotation invariance, BIP39 validation, malformed-input failure tests, and a test proving the reversible codec is unreachable through the wallet API.

Gate: derivation code passes independent review before UI work begins.

## Phase 4: dedicated recovery flow

Deliverables: explanation, two independent scans, mismatch display, profile/fingerprint confirmation, explicit reveal, stable numbered words, backup verification, and clear/exit behavior.

Gate: the user flow satisfies `PRD.md` without the excluded wallet/network features.

## Phase 5: security hardening

Deliverables: network-denial tests, CSP, Electron isolation/sandbox/navigation controls, secret lifecycle review, supply-chain inventory, artifact inspection, and signed release configuration.

Gate: no unresolved critical or high finding.

## Phase 6: independent verification

Deliverables: parity across web, Electron, Python, a second BIP39 library, two wallet libraries, and test-mode hardware-wallet acceptance; rotation and network-isolation evidence; built-asset secret/URL/source-map review.

## Phase 7: release and upstreaming

Deliverables: tagged source, offline web bundle, desktop artifacts, checksums, SBOM, provenance, specification, vectors, Python reference, security review, and standalone recovery guide.

Upstream contributions remain small and reviewable: inventory docs, profile/vectors, reversible-codec quarantine, derivation module, dedicated UI, hardening, then release tooling.
