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

## D-004: retain the reversible codec during audit

Date: 2026-08-08
State: accepted for Phase 0; final code disposition pending Phase 1 review

Do not delete the direct reversible codec until compatibility impact is understood. The intended disposition is internal/deprecated with an explicit name, subject to independent review.

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
