# Goal Status

Last updated: 2026-08-08

## Current state

Phase 0 and Phase 1 are complete and independently reviewed. `DK-BIP39-24-v1` is frozen on `codex/phase-1-freeze-profile`. No application feature code has started; Phase 2 must resolve the credential-free build and package-provenance foundation before derivation-module work.

| Item | State | Evidence |
| --- | --- | --- |
| Fork created | Complete | `https://github.com/nostitos/dicekeys-app-typescript` |
| `origin` / `upstream` topology | Complete | `origin` is the fork; `upstream` is `dicekeys/dicekeys-app-typescript` |
| Exact baseline pinned | Complete | `4eac9aa7248d40891b2d77527c4c1db39e3c9285` |
| Protected `main` | Complete | One approval, stale-review dismissal, last-push approval, linear history, conversation resolution, no force-push/deletion |
| BIP39 implementation trace | Complete | See `UPSTREAM_AUDIT.md` |
| Clean install/build/test baseline | Complete with recorded blocker | `common` passes; app roots are blocked by GitHub Packages `E401`; see `UPSTREAM_AUDIT.md` |
| Five wallet-output baselines | Complete for Phase 0 | Preserved as V01-V05 in the expanded corpus |
| Phase 0 independent review | Complete | Approved for the audit documentation and five baseline vectors only |
| `DK-BIP39-24-v1` specification | Complete and independently reviewed | Byte-level validation, canonicalization, keyed BLAKE2b construction, BIP39 encoding, compatibility, and error behavior are frozen |
| Independent references | Complete | Standard-library Python and standalone TypeScript match all 27 vectors and 108 rotations; all 13 invalid cases return the specified code |
| Phase 1 vector corpus | Complete | 27 valid public synthetic vectors, 13 invalid cases, one acquisition-policy case, and downstream wallet verification fields |
| Upstream compatibility | Complete at public source/WASM level | Pinned generated WASM SHA-256 `8a29007c...d1ec` matches 108 canonicalized `Secret` derivations |
| Independent wallet verification | Complete for committed vectors | `mnemonic` 0.21 agrees on all 27 BIP39 seeds; Scure 2.3.0 and `bip-utils` 2.12.1 agree on all 27 seeds, master fingerprints, and BIP84 addresses; the official BIP84 control vector matches |
| Phase 1 package provenance | Complete with deferred blocker | Public source/blob/workflow provenance is recorded; exact locked-package tarball equivalence is unverified and remains a Phase 2/release gate |
| Reversible codec disposition | Complete | Retain internally, use explicit legacy/experimental naming with deprecated aliases later, preserve decoder/vectors, never expose as wallet recovery |
| Phase 1 independent review | Approved | Fresh-eyes read-only reviewer authored no files, independently reimplemented the specification, reproduced all 27 vectors and 108 rotations, and reported no unresolved findings |
| Feature code | Not started | Intentionally gated |

## Gate summary

- Phase 0: passed with the credential-free dependency/build blocker documented, not repaired.
- Phase 1: passed independent review with no unresolved findings.
- Later phases: not started.

## Known blockers

- The checked-in npm configuration and lockfile resolve DiceKeys packages through GitHub Packages. The credential-free clean install fails and must be remediated only in Phase 2.
- The exact `@dicekeys/seeded-crypto-js@0.3.0` tarball cannot be acquired anonymously. Its lockfile SRI has not been matched to the pinned public source/WASM blob; Phase 2 and release remain blocked on an authorized comparison or an upstream anonymously downloadable provenance artifact.
