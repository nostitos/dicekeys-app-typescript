# Decision Log

Last updated: 2026-08-09

## D-001: one wallet profile

Date: 2026-08-08
State: accepted product decision

The first release exposes only `DK-BIP39-24-v1`: canonical DiceKey seed string, seeded-crypto `Secret`, exact recipe `{"purpose":"wallet"}`, 32-byte output, BIP39 English, 24 words.

## D-002: profile ID is metadata

Date: 2026-08-08
State: accepted product decision

`DK-BIP39-24-v1` identifies the compatibility contract. It is not added to the recipe because any recipe-byte change changes the derived output.

## D-003: seeded-secret path is the wallet path

Date: 2026-08-08
State: accepted product decision

Wallet recovery words use the existing seeded-crypto `Secret` path. The direct reversible DiceKey-layout codec has different semantics and must never be presented as wallet recovery.

## D-004: retain and quarantine the reversible codec

Date: 2026-08-08
State: accepted Phase 1 compatibility disposition; implementation belongs in a later isolated PR

Retain the direct reversible DiceKey-layout codec and its decoder for compatibility. When that code area is changed, give it an explicit legacy/experimental reversible-layout name, keep deprecated aliases for the existing exported names, and preserve fixed legacy vectors. It must remain unreachable from the wallet profile and wallet interface. Do not remove it without maintainer confirmation, a consumer-impact decision, and a documented migration window. This avoids destroying the only in-repository decoder for any historical deep-import users while separating its semantics from wallet recovery words.

## D-005: 24 words only

Date: 2026-08-08
State: accepted product decision

Version 1 encodes the 32-byte derived value as 24 BIP39 words. The UI will not offer other word counts.

## D-006: no feature edits before gates

Date: 2026-08-08
State: accepted process decision

Application behavior remains unchanged during the upstream audit. Derivation code is gated on specification review; UI code is gated on derivation-module review.

## D-007: exact upstream baseline

Date: 2026-08-08
State: accepted process decision

Phase 0 audits upstream commit `4eac9aa7248d40891b2d77527c4c1db39e3c9285`. Later upstream changes require a new recorded audit delta before adoption.

## D-008: v1 accepts only standard unique-letter DiceKeys

Date: 2026-08-08
State: accepted for Phase 1 specification; independently reviewed

`DK-BIP39-24-v1` accepts exactly 25 faces containing each permitted DiceKeys letter `ABCDEFGHIJKLMNOPRSTUVWXYZ` exactly once. Each digit must be `1` through `6`, and each orientation must be one of `t`, `r`, `b`, or `l`. Duplicate/missing letters, unknown orientations, excluded letters, invalid digits, and malformed lengths fail closed. This is stricter than the current generic upstream validator and intentionally treats a duplicate as a probable acquisition or transcription error for the wallet profile. The legacy generic path remains outside this profile while compatibility impact is assessed.

## D-009: acquisition confidence is separate from derivation

Date: 2026-08-08
State: accepted for Phase 1 specification; independently reviewed

The pure profile consumes validated faces and does not guess or repair input. A scanner must not invoke derivation while any face is ambiguous or automatically corrected. Acquisition software must surface uncertainty and require a clean reading or explicit manual correction; the later wallet UI additionally requires an independent second reading compared modulo physical rotation.

## D-010: wallet fields are verification metadata

Date: 2026-08-08
State: accepted for Phase 1 specification; independently reviewed

The profile output is the 24-word English BIP39 mnemonic. `bip39SeedWithEmptyPassphraseHex`, the BIP32 master fingerprint, and the first mainnet BIP84 receive address at `m/84'/0'/0'/0/0` are committed verification fields only. They do not add a BIP39 passphrase, network, address-generation, or wallet behavior to the profile.

## D-011: Phase 1 is a stacked specification change

Date: 2026-08-08
State: accepted process decision

Phase 1 lives on `codex/phase-1-freeze-profile`, based on the reviewed Phase 0 documentation commit. Its eventual pull request will be stacked on Phase 0 so the specification/reference diff remains separate. No React, Electron, scanner, or production API behavior belongs in this phase.

## D-012: package-tarball equivalence is a Phase 2 and release gate

Date: 2026-08-08
State: superseded for the replacement-artifact build path by D-013; historical provenance statement retained

Phase 1 freezes algorithm compatibility against the pinned public seeded-crypto 0.3.0 source/WASM blob and source-level derivation, which are independently executable and match all committed vectors. The exact GitHub Package tarball pinned by the app lockfile remains unavailable without an authorized `read:packages` credential, so its SRI has not been matched to that public blob. This did not block the user-defined Phase 1 specification gate, whose criteria were algorithm reproduction, rotation invariance, independent reimplementation, and a codec disposition. No document may claim that the inaccessible tarball is byte-equivalent until it is acquired and verified.

Phase 2 removes reliance on the inaccessible package rather than treating historical equality as a prerequisite. The old URL and SRI remain recorded as provenance; the new build path must identify its output as a source-built replacement and prove compatibility independently.

## D-013: replace private packages with pinned public-source builds

Date: 2026-08-08
State: accepted, implemented, and independently reviewed in Phase 2

Build the four DiceKeys packages from pinned public source commits into an ignored local cache, then install those artifacts through committed `file:` lock entries. The source pins are API `96e201f086ee53761293e6a7ee1d90b76398cbab`, scanner `af943feb6eb37d60dae3d12946ec51a3d3d5148d`, seeded crypto `6abb040989f4ad0dce5026e08407425ff57a401e`, and WASM memory helper `7b7f454efb1f6f7ae402a054fcb75db53b496db7`.

Each recipe must record the source commit and tree, acquired-source hash, compiler/build inputs, generated-blob hashes, normalized package-tree hash, new artifact integrity, historical package URL/SRI, license evidence, and whether historical bytes were compared. Generated sources and tarballs remain untracked. Raw git dependencies are rejected because the helper commit has no built `dist` entrypoint or prepare lifecycle.

This is an explicit provenance break. The helper and scanner historical package bytes were independently reconstructed from their public source commits with a compatible legacy packaging toolchain. API and seeded-crypto package bytes were not. Algorithm compatibility for seeded crypto remains independently established by all 108 Phase 1 derivations against the exact public generated blob.

## D-014: pin a supported Node and npm pair

Date: 2026-08-08
State: accepted Phase 2 build decision

The build contract requires Node `22.23.2` and npm `10.9.8`. Node 20 is end-of-life, the README and Volta Node 18 settings are stale, and a floating runtime cannot define a reproducible release foundation. A later compatibility matrix may exercise Node 24, but it cannot silently change the required artifact-producing toolchain.

## D-015: electron-builder is the only release desktop pipeline

Date: 2026-08-08
State: accepted Phase 2 build decision

The `electron/` application packaged by electron-builder is the canonical desktop path. The `electron-forge/` tree is an incomplete experiment: it has no application source or renderer outputs of its own and its declared main is absent. Phase 2 may compile its configuration and renderer target as a diagnostic, but it must never use Forge to produce release artifacts.

## D-016: Phase 2 desktop artifacts are unsigned and ineligible for release

Date: 2026-08-08
State: accepted gate-boundary decision

Phase 2 may produce a local, host-architecture Electron evaluation bundle only through an explicit unsigned configuration. It must set the macOS identity to `null`, omit the provisioning profile and notarization hook, disable DMG signing, omit Windows certificate selectors, use an `-unsigned` artifact name, and record `releaseEligible: false`. Signing, notarization, stapling, and platform publishing belong to a later protected release gate and must fail closed when implemented.

## D-017: a working build does not resolve the release blockers

Date: 2026-08-08
State: accepted security boundary

Credential-free installation and an unsigned local package are necessary but insufficient for distribution. Public release remains blocked until all of the following are resolved and independently reviewed:

- the repository and scanner's all-rights-reserved license text conflicts with package-level MIT claims;
- the seeded-crypto and scanner generated WASM build toolchains are portable, fully pinned, rebuilt, and hash-compared;
- `keytar@7.9.0` is replaced or its native binaries are acquired or rebuilt with verified content hashes;
- Electron is upgraded from unsupported major 29;
- wallet-inappropriate debugger, DYLD, unsigned-executable-memory, and library-validation entitlements are removed or narrowly justified; and
- the signed release path aborts on any signing or notarization failure.

## D-018: verification fingerprint is a Phase 4 decision

Date: 2026-08-08
State: accepted Phase 3 scope boundary; resolved for presentation metadata by D-020

The isolated Phase 3 derivation result exposes the profile identifier, an
immutable 24-word array, and the mnemonic string. It does not invent or expose
a `verificationFingerprint`: neither the frozen profile, the vector corpus,
nor the current application defines that value.

The committed BIP32 master fingerprint remains downstream verification
metadata under D-010. It depends on wallet/passphrase semantics and must not be
silently repurposed as a profile output. Before the Phase 4 UI displays any
verification fingerprint, a separate reviewed decision must define its exact
source bytes, domain separation, algorithm, truncation, encoding and display
format, collision purpose, and privacy/linkability behavior.

This scope decision does not change `DK-BIP39-24-v1` derivation bytes or any
committed vector, so it does not require vector regeneration.

## D-019: the wallet profile uses a cache-free, fail-closed derivation boundary

Date: 2026-08-08
State: accepted and independently reviewed in Phase 3

The production wallet-profile API validates and sanitizes exactly 25 face
objects before canonicalization and calls seeded crypto directly. It does not
route secret inputs or derived responses through the generic MobX/worker cache.
The public barrel exports only the frozen profile and one-argument mnemonic
derivation function; raw entropy, test vectors, validators, recipe overrides,
and the reversible layout codec remain outside that surface.

The seeded-crypto `secretBytes` getter creates a JavaScript byte-array copy.
The derivation boundary therefore retains and wipes that copy before deleting
the native `Secret`, owns only the additional copy required by the BIP39
encoder, and wipes that copy before returning the mnemonic-only public result
or propagating a cleanup failure. Immutable JavaScript seed and mnemonic
strings still cannot be perfectly erased; the later UI must minimize their
lifetime and clear all application references honestly.

Browser-mode and Electron-mode isolated loads must produce the same committed
anchor, but that test is not a substitute for packaged runtime E2E. Full web
and Electron execution remains part of the Phase 6 release-candidate gate.

## D-020: use a separate Recovery profile check code

Date: 2026-08-09
State: accepted, implemented, and independently reviewed in Phase 4

The flow uses a `Recovery profile check code v1`, not a wallet or BIP32
fingerprint. Its exact preimage is the UTF-8 bytes of
`DiceKeys/RecoveryProfileCheckCode/v1`, one zero byte, the UTF-8 bytes of
`DK-BIP39-24-v1`, one zero byte, and the exact canonical 24-word mnemonic with
single ASCII spaces. SHA-256 is applied once; the first six digest bytes are
rendered as twelve uppercase hexadecimal characters in three four-character
groups: `XXXX-XXXX-XXXX`.

The normative definition, public synthetic vectors, and independent Python
and TypeScript references live in `spec/RecoveryProfileCheckCode-v1.md` and
`spec/recovery-profile-check-code-v1-test-vectors.json`. The production API
accepts only the exact frozen Phase 3 result and returns only the formatted
code. It exposes no domain, profile, mnemonic, digest, truncation, or formatting
override.

This code is a short comparison aid for detecting that independently obtained
recovery material differs. It is not authentication, ownership proof, a unique
wallet identifier, an error-correcting checksum, or a substitute for comparing
and backing up all 24 words. A random different derivation has a one-in-2^48
chance of sharing the code. Because the value is deterministic and therefore
linkable, the wallet flow must not log, persist, transmit, copy, or place it in
URLs. This decision does not change `DK-BIP39-24-v1` derivation bytes or the
Phase 1 vector corpus and does not repurpose the BIP32 fingerprint in D-010.

## D-021: wallet recovery owns an isolated acquisition session

Date: 2026-08-09
State: accepted, implemented, and independently reviewed in Phase 4

Wallet recovery opts into a dedicated scanner mode while the legacy scanner
remains the default for existing application flows. An exact 25-face reading
may advance; bit-read uncertainty requires explicit review; incomplete,
no-majority, OCR-ambiguous, or wallet-invalid readings require a rescan. The
wallet path receives only sanitized letter, digit, and orientation fields and
must not write the DiceKey or center orientation to global application stores.

Wallet recovery registers a distinct attempt and its cleanup authority before
camera inventory discovery or media access. Each mounted scan attempt owns a
distinct worker, native image processor,
opaque session identifier, and monotonically increasing request identifier.
Replies must match all correlation fields. A terminal candidate is bound to
that exact attempt and makes camera, grabber, processor, media, callbacks, and
new requests inert before external code receives it. The flow enters an
explicit releasing state and may not advance to the physical break, comparison,
or derivation until the attempt's stable cleanup settlement resolves.

A worker bootstrap rejection, active processing rejection, or resolved WASM
exception before a candidate exists is also terminal in wallet mode. Capture is
made inert first, then external code receives only the fixed frozen result
`{status: "failed", reason: "scanner-attempt-failed"}` bound to the same cleanup
handle. The flow records `ACQUISITION_FAILED`; cleanup rejection instead
escalates to `ACQUISITION_DISPOSAL_FAILED`. Legacy scanner error behavior is
unchanged.

Cooperative cleanup wipes owned request/response buffers, deletes native state,
acknowledges the exact session, and then terminates the worker. If cleanup
cannot be confirmed within five seconds, or a worker/post/delete error occurs,
the main-thread copies and references are already cleared and the isolated
worker realm is terminated, but settlement rejects as
`ACQUISITION_DISPOSAL_FAILED`. The application must not claim that the fallback
explicitly overwrote worker memory or ran native deletion. It must never
advance using that acquisition. Readiness, frame-processing, and frame-capture
deadlines route a stalled attempt through the same fixed failure and cleanup
boundary. The two recovery readings must use distinct attempt identities and
objects before comparison across all four physical rotations. The dedicated
wizard implements these source-level rules; real-camera and packaged-runtime
E2E remain separate gates.
