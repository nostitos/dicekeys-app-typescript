# Release Checklist

Status: not release-ready
Last updated: 2026-08-08

## Compatibility and recovery

- [ ] All four physical rotations produce exactly the same 24 words.
- [ ] Existing upstream `{"purpose":"wallet"}` outputs remain unchanged.
- [ ] TypeScript, audited upstream WASM, and independent Python agree on every vector.
- [ ] At least 20 public synthetic vectors cover required edge cases.
- [ ] A second BIP39 library validates every mnemonic.
- [ ] Two independent wallet libraries agree on BIP32 fingerprints and BIP84 addresses.
- [ ] Test-mode hardware-wallet acceptance is complete without real funds.
- [ ] A future developer can recover words using the published specification alone.

## Build and supply chain

- [ ] Fresh clone bootstraps without personal credentials.
- [ ] Tests and builds run offline after dependency acquisition.
- [ ] Exact dependency versions and lockfiles are enforced.
- [ ] WASM source commit, build instructions, hash, license, and provenance are published.
- [ ] Install scripts are reviewed.
- [ ] Dependency/license inventory and SBOM are published.
- [ ] Release artifacts have SHA-256 checksums and provenance.

## Application security

- [ ] Wallet generation succeeds with networking disabled.
- [ ] Outbound-request E2E test passes for the complete wallet flow.
- [ ] No DiceKey, entropy, or mnemonic is persisted, logged, transmitted, or placed in URLs/history.
- [ ] No automatic clipboard access; default wallet flow has no copy or QR export.
- [ ] Explicit reveal, backup verification, and clear/exit behavior pass.
- [ ] Web CSP and service-worker controls pass review.
- [ ] Electron isolation, sandbox, navigation, protocol, permission, and signing checks pass.
- [ ] Built artifacts contain no test secrets, analytics URLs, remote scripts, or unintended source maps.
- [ ] Security review has no unresolved critical or high finding.

## Product boundaries

- [ ] The reversible layout codec cannot be selected through the wallet API or UI.
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
