# Goal Status

Last updated: 2026-08-09

## Current state

Phases 0, 1, 2, and 3 and the Phase 4 recovery foundation are complete and independently reviewed. `DK-BIP39-24-v1` is frozen on `codex/phase-1-freeze-profile`, the credential-free build foundation is complete on `codex/phase-2-public-build-foundation`, the isolated derivation module is complete on `codex/phase-3-derivation-module`, and the reviewed recovery foundation is on `codex/phase-4-recovery-foundation`. User-facing recovery UI work has not started.

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
| Phase 1 package provenance | Complete with explicit historical limit | Public source/blob/workflow provenance is recorded; exact seeded-crypto locked-package tarball equivalence remains unverified and is not claimed |
| Reversible codec disposition | Complete | Retain internally, use explicit legacy/experimental naming with deprecated aliases later, preserve decoder/vectors, never expose as wallet recovery |
| Phase 1 independent review | Approved | Fresh-eyes read-only reviewer authored no files, independently reimplemented the specification, reproduced all 27 vectors and 108 rotations, and reported no unresolved findings |
| Phase 2 dependency/source audit | Complete | All 1,073 public npm tarballs match their lock SRIs; four private packages are mapped to pinned public source; native downloads, generated WASM, licenses, and desktop pipelines are inventoried |
| Supported build runtime | Complete | Node 22.23.2 and npm 10.9.8 are selected and locally verified; Node 20 is end-of-life |
| Source-built replacement proof | Complete in disposable clone | Credential-free local packages pass common/web typecheck, all 13 Jest suites and 1,696 tests, web production build, Electron renderer build, Electron TypeScript build, and unsigned macOS arm64 packaging |
| Phase 2 implementation | Complete and independently reviewed | The three root commands, pinned public-source recipes, frozen local-package locks, normalized SBOM/provenance/checksums, unsigned packaging, and evidence-only CI contract passed with no unresolved review finding |
| Credential-free clean-machine proof | Complete | A new Linux/amd64 container with Node 22.23.2/npm 10.9.8 completed empty-cache bootstrap, all checks, and an unsigned build without private package credentials |
| Network-denied cache replay | Complete | A separate Docker run with `--network none` had no default route, returned `ENETUNREACH` for direct HTTPS, and passed offline bootstrap/check/build; all 14 checksum-bound evidence files matched the online run |
| Phase 3 derivation module | Complete and independently reviewed | The cache-free profile API validates exactly 25 faces, canonicalizes through the existing rotation primitive, derives with the exact frozen recipe, exposes only immutable mnemonic metadata, and keeps the reversible codec unreachable; all 27 vectors/108 rotations and 14 Jest suites/1,712 tests pass |
| Recovery profile check code | Complete and independently reviewed | Separate SHA-256/48-bit comparison metadata is frozen in its own spec and vectors, independently implemented in Python and TypeScript, and kept outside the BIP32/profile-output contract |
| Wallet scanner foundation | Complete and independently reviewed | Opt-in wallet mode owns a per-attempt worker/native session, fails closed on acquisition uncertainty, sanitizes face output, avoids global stores, correlates replies, makes capture inert before callback, and exposes one bounded cleanup settlement |
| Recovery flow foundation | Complete and independently reviewed | Pure state/comparison/backup modules enforce two distinct scans, fixed scanner-attempt failure handling, confirmed acquisition-release gates, all-four-rotation comparison, concealed derivation, explicit reveal, unbiased verification, and absorbing clear; combined checks pass 10 Python tests and 19 Jest suites/1,843 tests |

## Gate summary

- Phase 0: passed with the credential-free dependency/build blocker documented, not repaired.
- Phase 1: passed independent review with no unresolved findings.
- Phase 2: passed. Credential-free empty-cache acquisition, full verification, unsigned evaluation packaging, deterministic evidence, and operating-system-denied offline replay all passed independent review with no unresolved finding.
- Phase 3: passed. Independent review found and closed malformed-face coercion and an unnecessary seeded-crypto byte-copy lifetime; strict validation, cleanup-error paths, exact vectors, and same-module browser/Electron build-mode behavior now pass with no unresolved finding.
- Phase 4: foundation passed independent review with no unresolved finding;
  the user-facing wizard, navigation, visual QA, and packaged runtime E2E have
  not started.
- Phases 5 through 7: not started.

## Known blockers

- Phase 2 no longer resolves DiceKeys packages through GitHub Packages. The committed locks identify separately built local artifacts from pinned public source; this is an explicit provenance break, and historical package equality is not claimed except where separately reconstructed and recorded.
- The repository and scanner reserve all rights despite package-level MIT claims. Public redistribution remains blocked pending an unambiguous license grant and corrected notices.
- Seeded and scanner generated WASM build environments are not fully pinned or reproducible; scanner CMake also embeds a developer-local OpenCV path.
- `keytar@7.9.0` is archived and its prebuild installer does not content-verify downloaded native archives. Electron 29 is unsupported. Both must be replaced, upgraded, or brought under verified source-build control before release.
- Current Electron entitlements and signed/notarized packaging are not wallet-release ready. Phase 2 artifacts are local, unsigned, and explicitly `releaseEligible: false`.
- D-020 now defines the separate Recovery profile check code. The future UI
  must explain that it is comparison-only and privacy-linkable, must not
  persist or transmit it, and must not present it as authentication, ownership,
  a unique wallet identifier, or the BIP32 fingerprint.
