# Security Review

Status: Phase 1 compatibility, Phase 2 build/supply-chain, and Phase 3 derivation reviews complete; application adversarial review not started
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

The exact seeded-crypto GitHub Package tarball remains unavailable for SRI-to-public-blob comparison. `lockedPackageTarballIntegrityVerified` therefore remains false and no byte-equivalence claim is made. Phase 2 uses a separately identified source-built replacement instead of depending on that historical artifact; see D-013.

The approved Phase 1 scope changes only specification, vector, reference, and coordination artifacts. It changes no application, scanner, React, Electron, or wallet API behavior. All Phase 0 application findings below therefore remain open.

## Phase 2 supply-chain review

An independent read-only audit completed before the build implementation began. It recomputed SHA-512 over all 1,073 unique public npm tarballs referenced by the four lockfiles: 202,535,396 bytes were streamed with zero integrity mismatches. All 1,850 non-root lock occurrences have SHA-512 integrity metadata. The only inaccessible artifacts are the four DiceKeys GitHub Packages, each of which returns HTTP 401 without credentials.

The audit mapped those packages to exact public source commits and confirmed that a credential-free source-built replacement path is technically viable. The helper and scanner historical tarball bytes can be reconstructed from public source with compatible legacy packaging tools; API and seeded-crypto historical tarball equality is unverified. The pinned public seeded generated module still matches every Phase 1 compatibility vector. These facts support D-013 but do not make the application distributable.

Release-blocking findings:

| ID | Severity | Observation | Required disposition |
| --- | --- | --- | --- |
| SUPPLY-LICENSE-001 | Critical | The tracked repository/scanner license reserves all rights while package manifests claim MIT; the scanner package itself is `UNLICENSED`. | Obtain an unambiguous redistribution grant and correct repository/package notices before public artifacts. |
| SUPPLY-WASM-001 | Critical | Seeded and scanner JavaScript contain generated embedded WASM, but their Emscripten/native build environments are not fully pinned; the scanner build also contains a developer-local Windows OpenCV path. | Create portable content-pinned rebuilds and compare generated hashes before release. |
| SUPPLY-NATIVE-001 | High | Archived `keytar@7.9.0` uses `prebuild-install`, whose downloaded native archives are not content-verified by the package install path. | Replace keytar or explicitly acquire/build and verify each native input before installation. |
| SUPPLY-RUNTIME-001 | High | Electron 29 is outside Electron's supported latest-three-major policy. | Upgrade Electron and re-run application/security verification before release. |
| ELECTRON-SIGN-001 | High | The upstream notarization hook catches failures and the checked-in builder configuration embeds organization-specific signing selectors. | Keep Phase 2 explicitly unsigned; later signed configuration must take credentials only from protected environment state and fail closed. |
| ELECTRON-ENTITLE-001 | High | Current entitlements allow debugger access, DYLD variables, unsigned executable memory, and disabled library validation. | Remove each permission or document a narrow necessity before wallet release. |

The Phase 2 build may emit only local unsigned evaluation artifacts with `releaseEligible: false`. A successful bootstrap, test run, SBOM, or unsigned bundle is not a security approval or distribution license.

## Phase 2 build-contract verification

A fresh independent reviewer approved the final Phase 2 build contract with no unresolved critical, high, medium, or low finding. The review covered credential and Git-environment isolation, clean-source provenance, public-source package authentication, native-input acquisition, offline authority, destructive-path safety, deterministic archives and evidence, unsigned-package inspection, CI redistribution boundaries, and Windows/macOS/Linux portability.

The acceptance run used a clean Linux/amd64 container with Node 22.23.2 and npm 10.9.8. Starting with an empty project cache, it completed credential-free bootstrap, the complete check suite, and the unsigned build. A second container invocation used Docker `--network none`; it had no default route and a direct Node HTTPS probe failed with `ENETUNREACH`. In that network namespace:

- `./scripts/bootstrap --offline`, `./scripts/check`, and `./scripts/build-release --offline` all exited successfully;
- all 13 Jest suites and 1,696 tests passed with no skipped or todo tests;
- unsigned-package assertions and the complete 14-file checksum manifest passed;
- online and replay checksum-bound evidence matched;
- provenance recorded `dirty=false`, `releaseEligible=false`, and `acquisitionMode=cache-enforced-replay`; and
- application/vendor lockfiles and the acquired npm cache contained no `npm.pkg.github.com` resolution.

CI performs cross-platform cache replay with fail-fast proxy sentinels and uploads evidence JSON/SBOM/checksum files only. It does not upload the web or desktop bundles while redistribution rights remain unresolved, and it does not claim that proxy settings are operating-system-level network isolation. The Docker network-namespace run above is the Phase 2 network-denial evidence.

## Phase 3 derivation-module review

Fresh read-only reviewers independently audited the isolated wallet API and its
conformance suite before any UI work. The implemented path does not use the
generic MobX/worker response cache. It validates and copies a clean 25-face
tuple, uses the existing rotation-canonicalization primitive, calls the pinned
seeded-crypto `Secret` operation with the exact frozen recipe, converts the
32-byte result through the existing BIP39 encoder, and returns only the profile
identifier, frozen word array, and mnemonic string.

The first review pass found two gate-blocking issues, both fixed before
approval:

- raw face fields were concatenated through JavaScript coercion before their
  structure was checked, allowing malformed arrays to serialize as a valid
  DiceKey; the boundary now requires exactly 25 non-array objects with own,
  primitive, single-character data properties before applying the normative
  error precedence and uniqueness checks; and
- the seeded-crypto `secretBytes` getter returns a fresh JavaScript byte-array
  copy, which had been copied again without wiping the getter result; the code
  now retains and zeroes that temporary copy before deleting the native object,
  and zeroes any owned copy before propagating a cleanup failure.

Regression tests cover smuggling, non-string coercion, inherited and accessor
fields, extra scanner metadata sanitization, numeric WASM errors, getter and
native-delete failures, temporary and owned byte-array wiping, exact recipe
bytes, whitespace sensitivity, all 27 vectors and 108 rotations, the BIP39
checksum and word-list hash, ambiguity rejection, and reversible-codec API
isolation. The final gate passes 14 Jest suites and 1,712 tests with no skipped
or todo work, the independent Python/TypeScript parity suite, type checking,
and web, Electron, and Forge builds.

The browser/Electron test proves equal results from isolated module loads under
both build-mode constants and verifies that the profile module has no platform
dependency. It is not packaged-renderer E2E evidence; actual web and Electron
runtime execution, active-flow network denial, UI state clearing, and mnemonic
string-lifecycle review remain later gates. No verification fingerprint is
implemented because its normative and privacy semantics are not yet defined.

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
- Release-grade resolution of the recorded license, generated-WASM, keytar, Electron, entitlement, and signing blockers.
- UI/session cache eviction, mnemonic string-copy review, clear/exit behavior, and honest limitations of JavaScript erasure beyond the reviewed Phase 3 byte-array and native-object cleanup.
- Independent review after implementation, with no self-approval.
