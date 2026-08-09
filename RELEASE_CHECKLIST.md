# Release Checklist

Status: not release-ready
Last updated: 2026-08-09

## Compatibility and recovery

- [x] All four physical rotations produce exactly the same 24 words.
- [x] Existing upstream `{"purpose":"wallet"}` outputs remain unchanged at the pinned public source/WASM compatibility target.
- [x] TypeScript, audited upstream WASM, and independent Python agree on every vector.
- [x] At least 20 public synthetic vectors cover required edge cases (27 committed).
- [x] A second BIP39 library validates every mnemonic.
- [x] Two independent wallet libraries agree on BIP32 fingerprints and BIP84 addresses.
- [x] The isolated production API matches all 27 vectors and 108 rotations without exposing raw entropy.
- [x] Recovery profile check-code v1 has a separate normative specification,
      public vectors, independent Python/TypeScript references, and no BIP32 or
      authentication claim.
- [ ] Test-mode hardware-wallet acceptance is complete without real funds.
- [x] An independent reviewer reproduced the words using the published specification alone.

## Build and supply chain

- [x] Fresh clone bootstraps without personal credentials.
- [x] Tests and builds run offline after dependency acquisition, including an independently observed Docker `--network none` replay.
- [x] Exact dependency versions and lockfiles are enforced.
- [x] Every public npm tarball in the inherited locks was independently content-verified against its SHA-512 SRI.
- [x] Source-built DiceKeys replacements have pinned commits, acquisition hashes, normalized package-tree hashes, new artifact integrity, historical provenance, and clean-clone verification.
- [ ] WASM source commit, portable pinned rebuild instructions, generated hash comparison, license, and provenance are published.
- [ ] Repository and scanner redistribution rights are unambiguous and compatible with the intended release.
- [ ] Keytar is replaced or every native input is acquired or rebuilt under content verification.
- [ ] Electron is on a supported major and the upgraded application passes full security review.
- [x] Phase 2 install scripts and every out-of-lock native acquisition path are inventoried and constrained by the build contract; unresolved legacy keytar delivery remains a release blocker above.
- [x] A normalized dependency/license inventory and CycloneDX SBOM set are generated and checksum-bound for evaluation; public release publication remains blocked.
- [x] Phase 2 evaluation artifacts have complete SHA-256 checksums and provenance.
- [x] Every Phase 2 desktop artifact is labeled unsigned and records `releaseEligible: false`.

## Application security

- [ ] Wallet generation succeeds with networking disabled.
- [ ] Outbound-request E2E test passes for the complete wallet flow.
- [ ] No DiceKey, entropy, or mnemonic is persisted, logged, transmitted, or placed in URLs/history.
- [x] The isolated derivation API deletes its native `Secret` and wipes temporary and owned entropy byte arrays on reviewed success and cleanup-error paths.
- [x] The wallet-scanner foundation isolates each attempt, rejects or surfaces
      every acquisition uncertainty, avoids global DiceKey stores, correlates
      worker replies, makes capture inert before callback, and provides bounded
      confirmed-or-failed cleanup plus fixed pre-terminal worker/WASM failure
      handling without an erasure overclaim.
- [x] The pure recovery-flow foundation enforces two distinct readings,
      first/second acquisition-release gates, four-rotation comparison without
      tie guessing, concealed derivation, explicit reveal state, unbiased
      backup challenges, and absorbing clear.
- [ ] No automatic clipboard access; default wallet flow has no copy or QR export.
- [ ] Explicit reveal, backup verification, and clear/exit behavior pass.
- [ ] Web CSP and service-worker controls pass review.
- [ ] Electron isolation, sandbox, navigation, protocol, permission, and signing checks pass.
- [ ] Built artifacts contain no test secrets, analytics URLs, remote scripts, or unintended source maps.
- [ ] Security review has no unresolved critical or high finding.

## Product boundaries

- [x] The reversible layout codec cannot be selected through the wallet API.
- [ ] The reversible layout codec cannot be selected through the wallet UI.
- [ ] The normal UI contains no signing, transaction, balance, address, network-wallet, passphrase-storage, SLIP39, or cloud-backup feature.
- [ ] UI exposes only the 24-word English v1 profile.

## Artifacts

- [ ] Source tag.
- [ ] Offline web bundle.
- [ ] Signed macOS, Windows, and Linux artifacts.
- [ ] `DK-BIP39-24-v1` specification and vectors.
- [ ] Independent Python reference implementation.
- [ ] Security review.
- [ ] Standalone recovery guide.
