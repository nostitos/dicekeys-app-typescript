# DiceKeys Wallet Recovery Product Requirements

Status: approved project direction; implementation gated on Phase 0 audit and Phase 1 specification review
Profile: `DK-BIP39-24-v1`
Last updated: 2026-08-08

## Goal

Ship a secure, offline-first flow that deterministically derives standard 24-word BIP39 English recovery words from a physical DiceKey while preserving the existing DiceKeys `Secret` derivation for the exact recipe string `{"purpose":"wallet"}`.

This project audits and hardens an existing capability. It does not introduce a new DiceKey-to-BIP39 algorithm.

## Compatibility contract

The release profile is identified by the metadata name `DK-BIP39-24-v1` and uses:

1. The official rotation-independent 75-character DiceKey seed string.
2. Seeded-crypto `Secret` derivation.
3. The exact UTF-8 recipe bytes `{"purpose":"wallet"}`.
4. The exact BLAKE2b/HKDF behavior used by the audited upstream seeded-crypto implementation.
5. A 32-byte derived secret encoded as 24 BIP39 English words.

The profile identifier is not inserted into the recipe. No release may silently change any compatibility input.

## User experience

The primary action is `Create Bitcoin wallet recovery words`. The release flow must:

1. Explain the consequences of exposing the recovery words.
2. Obtain a complete DiceKey reading.
3. Require an independent second reading and compare it modulo physical rotation.
4. Show the profile identifier and a non-secret verification fingerprint.
5. Require an explicit reveal action before displaying a stable numbered 24-word grid.
6. Verify the user's backup before completion.
7. Clear the active secret-generation state and return to a neutral screen.

## Security requirements

- Derivation must work with networking disabled.
- No DiceKey, derived entropy, or mnemonic may be logged, transmitted, or persisted by the wallet flow.
- The normal wallet flow must not copy to the clipboard or produce a QR code.
- Ambiguous or malformed input must fail closed; no wallet generation may use an automatic best guess.
- Web and Electron builds must enforce the controls in `SECURITY_REVIEW.md`.
- Release artifacts must include checksums, an SBOM, build provenance, and reproducible build instructions.
- Only public synthetic test material may be used in development and acceptance testing.

## First-release exclusions

- Signing, transactions, balances, or network wallet features.
- Address generation in the normal UI.
- Word-count selection other than 24 words.
- BIP39 passphrase generation or storage.
- SLIP39 or cloud backup.
- Reversible DiceKey-layout mnemonics.
- Default clipboard or QR export.

## Acceptance criteria

The definition of done is tracked in `RELEASE_CHECKLIST.md`. In particular, all four rotations of a test DiceKey must produce the same mnemonic, existing upstream wallet outputs must remain unchanged, three independent implementations must agree on committed vectors, a fresh clone must build without personal credentials, and no critical or high-severity security finding may remain open.
