# Implementation Plan

Status: Phases 0 through 4 complete and independently reviewed; Phase 5 security hardening not started
Last updated: 2026-08-09

## Working model

- The supervisor owns scope, gates, coordination documents, and merge decisions.
- Audit and verification agents are read-only.
- An implementation agent receives one bounded code area at a time only after the relevant gate passes.
- No agent approves or merges its own work.
- Tests, committed vectors, production builds, and independent review determine completion.
- User-facing application behavior remains unchanged until Phase 4, and no UI work begins before the isolated derivation module passes independent review.

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

Result: passed independent review. The new cache-free API binds the exact
profile and recipe, strictly validates and sanitizes 25 runtime faces before
canonicalization, matches all 27 vectors and 108 rotations, preserves BIP39
checksum and word-list provenance, and does not export entropy, a recipe
override, the reversible codec, or the internal test seam. Review-discovered
face-coercion and temporary-byte-copy lifetime defects were fixed and covered
across success and cleanup-error paths. The complete check now passes 14 Jest
suites and 1,712 tests plus the independent Python/TypeScript references and
web, Electron, and Forge builds.

The build-mode regression proves that fresh browser-mode and Electron-mode
module loads produce the same fixed result. Actual browser and packaged
Electron runtime execution remains a Phase 6 E2E gate. D-020 now separately
defines the presentation-only Recovery profile check code without changing the
Phase 3 derivation result or repurposing BIP32 metadata.

## Phase 4: dedicated recovery flow

Deliverables: explanation, two independent scans, mismatch display, profile and
Recovery profile check code v1 confirmation, explicit reveal, stable numbered
words, backup verification, and clear/exit behavior.

Foundation result: passed independent review. It freezes
the check-code specification and independent references; introduces an opt-in,
per-attempt wallet scanner session with strict uncertainty and bounded cleanup
policy; and provides a pure recovery state machine for two distinct,
attempt-bound acquisitions, confirmed release gates, four-rotation comparison,
concealed derivation, explicit reveal, unbiased backup challenges, and
absorbing clear.

UI result: passed repeated fresh, read-only review. The dedicated home action
and `/wallet-recovery` route render every foundation state without a parallel
step machine. Wallet camera registration precedes discovery; each attempt owns
its worker, media, watchdogs, result correlation, and cleanup authority.
Uncertain faces require review or rescan, cleanup must settle before later
stages, and any late pending or unconfirmed cleanup clears material and blocks
the ceremony. The interface provides explicit reveal, stable numbered words,
two local backup-verification modes, comparison-only check-code guidance, keyboard
focus management, responsive reflow, fresh history restoration, and an honest
neutral clear receipt. It contains no clipboard, QR, print, network-wallet,
address, signing, persistence, or reversible-codec surface.

The complete candidate passes 10 Python reference tests and 23 Jest suites/
1,998 tests with no skipped, todo, or snapshot work, plus type checks and web,
Electron, and Forge builds. Limited live-browser QA verified the route, consent
gate, responsive DOM geometry, focus, explicit clear receipt, and fresh
Back/Forward state without granting camera permission. Real-camera browser
execution, packaged Electron E2E, active-flow network denial, and built-artifact
inspection remain Phase 5/6 gates.

Gate: passed for the reviewed source-level flow; runtime and release-candidate
security gates remain in Phases 5 and 6.

## Phase 5: security hardening

Deliverables: network-denial tests, CSP, Electron isolation/sandbox/navigation controls, secret lifecycle review, supply-chain inventory, artifact inspection, and signed release configuration.

Gate: no unresolved critical or high finding.

## Phase 6: independent verification

Deliverables: parity across web, Electron, Python, a second BIP39 library, two wallet libraries, and test-mode hardware-wallet acceptance; rotation and network-isolation evidence; built-asset secret/URL/source-map review.

## Phase 7: release and upstreaming

Deliverables: tagged source, offline web bundle, desktop artifacts, checksums, SBOM, provenance, specification, vectors, Python reference, security review, and standalone recovery guide.

Upstream contributions remain small and reviewable: inventory docs, profile/vectors, reversible-codec quarantine, derivation module, dedicated UI, hardening, then release tooling.
