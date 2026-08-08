# Decision Log

Last updated: 2026-08-08

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
State: accepted gate-boundary decision; no provenance equivalence claim

Phase 1 freezes algorithm compatibility against the pinned public seeded-crypto 0.3.0 source/WASM blob and source-level derivation, which are independently executable and match all committed vectors. The exact GitHub Package tarball pinned by the app lockfile remains unavailable without an authorized `read:packages` credential, so its SRI has not been matched to that public blob. This does not block the user-defined Phase 1 specification gate, whose criteria are algorithm reproduction, rotation invariance, independent reimplementation, and a codec disposition. It remains an explicit Phase 2 build/supply-chain blocker and a release blocker. No document may claim that the inaccessible tarball is byte-equivalent until it is acquired and verified.
