# Security Review

Status: Phase 1 compatibility review complete; application adversarial review not started
Last updated: 2026-08-08

No item in this file is an approval of the current application for wallet recovery.

## Phase 1 compatibility review

An independent read-only reviewer who authored no candidate files approved the frozen profile on 2026-08-08 with no unresolved critical, high, medium, or low conformance finding. The review independently reimplemented the normative specification and reproduced:

- all 27 valid synthetic vectors and all 108 physical-rotation derivations;
- all 13 fail-closed validation cases and their error precedence;
- the leading-zero search fixture;
- every BIP39 mnemonic and empty-passphrase seed;
- every BIP32 master fingerprint and BIP84 first-receive address;
- the official BIP84 control vector; and
- the pinned public upstream WASM outputs for the exact wallet recipe.

The review confirmed that the specification's two keyed BLAKE2b-256 calls match the pinned seeded-crypto source and are not RFC 5869 HMAC-HKDF. Scure 2.3.0 and `bip-utils` 2.12.1 independently agreed on the downstream wallet fields; `mnemonic` 0.21 independently agreed on the BIP39 seeds.

The exact GitHub Package tarball remains unavailable for SRI-to-public-blob comparison. `lockedPackageTarballIntegrityVerified` therefore remains false. This is an unresolved Phase 2 build/supply-chain and release blocker; no byte-equivalence claim is made.

The approved Phase 1 scope changes only specification, vector, reference, and coordination artifacts. It changes no application, scanner, React, Electron, or wallet API behavior. All Phase 0 application findings below therefore remain open.

## Phase 0 observations

| ID | Severity | Observation | Required disposition |
| --- | --- | --- | --- |
| WALLET-UI-001 | High | The existing generic recipe view reveals derived output by default unless a persisted hide flag is explicitly true. | Dedicated flow must require explicit reveal. |
| WALLET-UI-002 | High | The generic derived-output toolbar offers clipboard copy and QR display for BIP39 output. | Omit both from the normal wallet flow. |
| WALLET-SCAN-001 | High | Scanner logic may accept underline/overline bit errors after a time/frame threshold rather than requiring an unambiguous reading. | Wallet flow must fail closed and require explicit correction/re-scan. |
| WALLET-SCAN-002 | High | General DiceKey validation does not require one instance of each face letter by default. | Phase 1 must freeze wallet-specific duplicate-letter policy. |
| WALLET-SCAN-003 | High | The general runtime validator can accept an unknown `?` orientation even though human-readable parsing is stricter. | Wallet API must accept only explicitly known orientations. |
| WALLET-PROFILE-001 | High | UI format selection lowercases purpose, while derivation uses byte-exact recipe text; `WALLET` selects BIP39 but derives different bytes from the frozen lowercase recipe. | Dedicated API must bind exact profile ID to exact recipe bytes. |
| BIP39-IMPORT-001 | Medium | The existing decoder accepts non-canonical trailing entropy, extra valid words, and has whitespace/case-normalization weaknesses. | Keep it outside wallet recovery or harden and test any remaining import surface. |
| WALLET-LIFE-001 | Medium | `CachedApiCalls` and asynchronous calculation caches retain derived response material in process memory without a wallet-specific clear operation. | Create bounded lifecycle and explicit clear behavior. |
| WEB-001 | High | The web build has no wallet-session network-denial control or restrictive `connect-src` policy identified in Phase 0. | Add restrictive CSP and outbound-request E2E failure test. |
| WEB-002 | Medium | Production web builds emit source maps. | Decide release policy and scan artifacts for sensitive material. |
| ELECTRON-001 | Critical | The audited Electron window explicitly enables `nodeIntegration: true`; required isolation/sandbox controls are not established. | Set `nodeIntegration: false`, `contextIsolation: true`, sandboxing, and navigation/protocol restrictions before release. |
| SUPPLY-001 | High | DiceKeys dependencies resolve through GitHub Packages and the README requires a personal token. | Replace with a credential-free, pinned, provenance-documented build path. |
| SUPPLY-002 | High | Lockfile metadata labels core DiceKeys packages as `NOT YET LICENSED` or `UNLICENSED`. | Resolve licensing before distribution. |

## Checks still required

- Analytics, crash reporting, remote fonts/scripts, and service-worker behavior.
- URL/history/storage/console/test-snapshot searches for secret material in built artifacts and runtime flows.
- Network capture during scan, derivation, display, verification, and clear.
- Electron permission, navigation, external-protocol, shell, camera, signing, and fuse verification on packaged artifacts.
- Dependency install-script review, licenses, WASM provenance/hash, SBOM, and isolated release build.
- Secret-object deletion, unnecessary string-copy review, cache eviction, and honest limitations of JavaScript erasure.
- Independent review after implementation, with no self-approval.
