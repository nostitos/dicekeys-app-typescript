# Upstream Audit

Status: Phase 0 complete; independently approved for the audit documentation and five baseline vectors
Audit date: 2026-08-08
Application behavior changed: no

## Scope and provenance

Repository: `dicekeys/dicekeys-app-typescript`
Audited upstream commit: `4eac9aa7248d40891b2d77527c4c1db39e3c9285`
Commit date: 2024-04-04T14:27:03-04:00
Commit subject: `Merge pull request #242 from dicekeys/ci-with-node-20`

Fork topology established for the project:

- `origin`: `https://github.com/nostitos/dicekeys-app-typescript.git`
- `upstream`: `https://github.com/dicekeys/dicekeys-app-typescript.git`
- working branch: `codex/phase-0-upstream-audit`
- fork `main`: protected with one approval, stale-review dismissal, last-push approval, linear history, resolved conversations, and force-push/deletion disabled

The audit used tracked source at the exact commit. No application source was edited. Normal ignored dependency/build artifacts were produced only by baseline commands.

## Executive conclusions

1. Upstream contains two semantically different BIP39 mechanisms.
2. The direct DiceKey-layout codec is not reachable through production UI or application API code at this commit. Its only non-definition consumer is `web/src/tests/bip39.test.ts`.
3. The production wallet route is canonical DiceKey seed string → seeded-crypto `Secret.deriveFromSeed` → 32 secret bytes → BIP39 English encoding.
4. The built-in `Cryptocurrency wallet seed` recipe exists and is exactly `{"purpose":"wallet"}` after the UI's recipe canonicalization.
5. The production route is rotation invariant at the seed-string boundary. Five fixed public synthetic DiceKeys produced identical wallet outputs under all four rotations when exercised against the generated upstream seeded-crypto 0.3.0 WASM source blob.
6. Upstream has no fixed wallet-output vectors or wallet-path regression tests. Existing BIP39 tests cover standard entropy vectors and the separate reversible layout codec.
7. A clean credential-free build is currently impossible: GitHub Packages rejects the pinned DiceKeys dependencies without a personal token. Consequently the checked-in app's Jest, web, and Electron build commands cannot start in the clean baseline.
8. The current generic recipe UI is not an acceptable wallet recovery flow: it reveals output by default, allows plaintext copy/QR even while visually hidden, uses a single general scan, and has no backup verification or wallet-specific clear step.

## Repository and environment baseline

The repository has no root package workspace. It contains four independent npm roots: `common`, `web`, `electron`, and `electron-forge`, each with a lockfile version 3.

Audit host:

```text
macOS 26.5.1 (25F80), arm64
Node.js 20.19.5 for authoritative commands
npm 10.8.2
Python 3.14.2
Docker 28.2.2
Xcode Command Line Tools: /Library/Developer/CommandLineTools
```

The repository does not pin a runtime through `engines`, `packageManager`, `.nvmrc`, or `.node-version`. `web/package.json` does contain a Volta declaration for Node 18.1.0 and npm 8.9.0; the README says Node 18 was tested, while CI uses Node 20. Commands below explicitly forced the CI-matching Node 20 binary because package-directory shells otherwise resolved a different locally installed Node version.

## Clean install, tests, and builds

### Credential-free install results

Each command used `env PATH=/Users/t/.nvm/versions/node/v20.19.5/bin:$PATH /usr/bin/time -p npm ci` from the named package root.

| Root | Result | Time | Evidence |
| --- | --- | ---: | --- |
| `common` | Pass | 2.15s | 3 packages added; 0 reported vulnerabilities |
| `web` | Fail | 1.94s | `E401`, authentication token not provided for `@dicekeys/webasm-module-memory-helper` 1.0.6 |
| `electron` | Fail | 2.60s | `E401` for `@dicekeys/dicekeys-api-js` 0.1.13 |
| `electron-forge` | Fail | 1.81s | `E401` for `@dicekeys/dicekeys-api-js` 0.1.13 |

The root and app `.npmrc` files select `https://npm.pkg.github.com` for the `@dicekeys` scope but contain no token configuration. The README explicitly instructs contributors to obtain a personal token with `read:packages`. The audit environment had no package token, user `.npmrc`, or matching keychain credential. Supplying the already-authorized `gh` token ephemerally did not solve this: once correctly presented to npm, GitHub returned `E403` because that token lacks the required package scope. No credential was persisted.

### Check/build results after the clean install attempt

| Command | Result | Interpretation |
| --- | --- | --- |
| `common: npm run build` | Pass, 1.91s | TypeScript 5.4.3 compiled `common` |
| `web: npm run typecheck` | Fail before check | `tsc` unavailable because install failed |
| `web: npm test` | Fail before Jest | Jest module unavailable; 0 suites and 0 tests executed |
| `web: npm test -- --runTestsByPath src/tests/bip39.test.ts` | Fail before Jest | Same dependency blocker; 0 BIP39 tests executed |
| `web: npm run build-web` | Fail before build | `rimraf` unavailable |
| `web: npm run build-electron-html` | Fail before build | `rimraf` unavailable |
| `web: npm run build-electron-forge-html` | Fail before build | `rimraf` unavailable |
| `electron: npm run build` | Fail before compilation | `rimraf` unavailable |
| `electron: npm run pack` | Fail before packaging | `electron-builder` unavailable |
| `electron-forge: npm run compile-forge-config` | Fail before compilation | `tsc` unavailable |
| `electron-forge: npm run package` | Fail before packaging | `tsc` unavailable |

These are dependency-acquisition failures, not evidence of source-level test or compiler failures. They must remain recorded separately from any later authenticated or remediated run.

### CI and packaging gaps

- CI installs only `common` and `web`.
- CI runs `npm run build --if-present` in `web`, but `web/package.json` defines no `build` script, so the production web build is not exercised.
- CI does not exercise either Electron build.
- Electron/macOS packaging configuration expects Apple credentials, a DiceKeys signing identity, and a provisioning profile that are not present on the audit host.
- No checked-in SBOM or release provenance flow was found.

## Mechanism A: direct reversible DiceKey-layout codec

Definitions:

- `web/src/formats/bip39/bip39.ts:109-118`: face ↔ integer 0–599 mapping.
- `web/src/formats/bip39/bip39.ts:121-125`: `bip39StringToDiceKey`.
- `web/src/formats/bip39/bip39.ts:128-132`: `diceKeyToBip39WordArray` and `diceKeyToBip39String`.

Consumers:

- `web/src/tests/bip39.test.ts:3`: the only import of the direct conversion functions.
- `web/src/tests/bip39.test.ts:64-77`: all direct-codec callers and round-trip tests.

No production file imports `diceKeyToBip39String`, `diceKeyToBip39WordArray`, or `bip39StringToDiceKey`. No public barrel exports them, and no UI or URL/API request selects them.

The encoder maps 25 faces to 25 ten-bit values (250 bits), zero-pads to 32 bytes, and applies standard 24-word BIP39 encoding. The decoder validates the BIP39 checksum, consumes the first 25 ten-bit values, and ignores the remaining six entropy bits. Thus the tested encoder→decoder round trip works, but arbitrary valid mnemonics with different trailing entropy bits may decode to the same face layout.

The direct encoder consumes `diceKey.faces` as supplied. It does not use `toSeedString()` or rotation-independent canonicalization. In an independent audit example, all four physical rotations produced four different direct-codec mnemonics. This confirms that it is a representation of an observed arrangement, not the wallet derivation profile.

Disposition for Phase 0: retain, do not expose, and do not conflate with wallet recovery. Final rename/deprecation/removal policy remains a Phase 1 reviewed decision.

## Mechanism B: production seeded-secret wallet path

### Built-in selection

- `web/src/dicekeys/StoredRecipe.ts:49-63` defines the built-in recipes.
- Line 62 is the sole exact wallet entry: `new BuiltInRecipe("Secret", "Cryptocurrency wallet seed", \`{"purpose":"wallet"}\`)`.
- `web/src/views/Recipes/LoadRecipeView.tsx:25-66` populates the generic recipe selector and loads the selected built-in.
- `web/src/views/Recipes/RecipeBuilderState.ts:495-513` canonicalizes loaded JSON. The one-field wallet recipe remains byte-for-byte `{"purpose":"wallet"}`.

### Canonical DiceKey seed

- `web/src/views/Recipes/DerivedFromRecipeState.ts:67-71` obtains `diceKey.toSeedString()`.
- `web/src/dicekeys/DiceKey/index.ts:75-80` rotates to a rotation-independent form and serializes it.
- `web/src/dicekeys/DiceKey/Rotation.ts:37-61` serializes all four complete rotations and keeps the lexicographically earliest string.
- `web/src/dicekeys/DiceKey/HumanReadableForm.ts:11-20` concatenates 25 letter/digit/orientation triples into 75 characters.

### Seeded-crypto call

- `web/src/api-handler/CachedApiCalls.ts:67-84` dispatches the request to a worker and caches the response.
- `web/src/workers/call-api-command-worker.ts:17-28` constructs the worker request.
- `web/src/workers/api-command-worker.ts:24-35` receives the seed string and request.
- `web/src/api-handler/SeededApiCommands.ts:83-88` calls `Secret.deriveFromSeed(this.#seedString, recipe)` and deletes the native object after JSON serialization.
- `web/src/api-handler/CachedApiCalls.ts:101-121` extracts `secretBytes`; only an exact 32-byte result is passed to BIP39.

The application lockfile pins `@dicekeys/seeded-crypto-js` 0.3.0 with integrity `sha512-Ftz+1ownyccibVao+7KYI0oO+jKvWqS3UDPFCx7GeLpuLjiqVGhdtv28LKZdrX5m0ji9d+s4eJ9XW2bvYT7YZA==` at `web/package-lock.json:637-645`. Version commit `6abb040989f4ad0dce5026e08407425ff57a401e` contains generated JavaScript/WASM blob `a2e1b576c3ff15f665fd7adf9035ea092e0ba938` (SHA-256 `8a29007c11ebd0a0e8793089c6aa480633474d0336a41f0f4b248ef385b6d1ec`); that blob is unchanged at the later merge commit `cd8c87cf93199f2d8facd8b6a6b54a1c4b67626f`. Both point to seeded-crypto C++ submodule commit `8e1d1965c1720b8964e3ee1880163f7a6b221781`.

The public release workflow copies `src/seeded-crypto-js.*` into the package distribution. However, Phase 0 could not acquire the locked GitHub Package tarball anonymously or with the current token, so the lockfile's package-integrity value has not yet been cryptographically matched to the public generated-source blob. The Phase 0 WASM results below are executions of that pinned public 0.3.0 source blob, not a claim that the inaccessible tarball was compared byte-for-byte.

### BIP39 selection and conversion

- `web/src/views/Recipes/DerivedFromRecipeState.ts:15-20` includes BIP39 as a Secret output format.
- `web/src/views/Recipes/DerivedFromRecipeState.ts:76-100` honors an existing per-type user choice first, otherwise defaults purpose `wallet` to BIP39.
- `web/src/views/Recipes/DerivedFromRecipeState.ts:136-160` calls `getSecretBip39ForRecipe` for the selected BIP39 format.
- `web/src/api-handler/CachedApiCalls.ts:118-122` converts the 32 bytes.
- `web/src/formats/bip39/bip39.ts:56-67` appends the first SHA-256 checksum byte, maps 24 11-bit indices to the hard-coded English list, and joins with single spaces.
- `web/src/views/Recipes/DerivedFromRecipeView.tsx:53-70,206-207` renders 24 numbered words.

The exact audited seeded-crypto calculation is recorded, non-normatively pending Phase 1 review, in `spec/DK-BIP39-24-v1.md`.

## Current reveal, copy, and QR behavior

- `web/src/state/stores/HideRevealSecretsState.ts:15-60` stores hide/reveal preference by only the center letter and digit.
- `web/src/views/basics/GeneratedTextField.tsx:67-69` passes a default hide value of `false`, so an unset state displays the mnemonic.
- `web/src/views/Recipes/DerivedFromRecipeView.tsx:53-70` replaces words with length-matched asterisks only when hidden; this is visual masking, not secret removal.
- `web/src/views/Recipes/DerivedFromRecipeView.tsx:182-188` sends the plaintext `derivedValue` directly to `navigator.clipboard.writeText`.
- `web/src/views/Recipes/DerivedFromRecipeView.tsx:177-179,189-193` sends the same plaintext to the QR overlay.
- Copy and QR actions remain available while the on-page words are visually hidden.
- `web/src/views/Recipes/QrCodeOverlay.tsx:49-75` begins QR generation from the plaintext and later displays both QR and text.

The external DiceKeys URL/API supports seeded `getSecret` responses, not BIP39 mnemonics and not the reversible codec. The mnemonic conversion is an in-app presentation path.

## Input and scanner behavior relevant to the wallet profile

- Human-readable parsing requires exactly 75 characters and valid face characters (`HumanReadableForm.ts:22-46`).
- `validateDiceKey` checks 25 faces and valid letters/digits/orientations, but duplicate letters are accepted unless `requireOneOfEachLetter` is explicitly true (`validateDiceKey.ts:36-88`).
- The general validator checks the runtime `FaceOrientationLetterTrblOrUnknown` predicate, so an unknown `?` orientation can pass that layer despite the narrower TypeScript type; human-readable parsing is stricter.
- The generic scanner can terminate with underline/overline bit errors after at least one second and four frames (`DiceKeyFrameProcessorState.ts:90-140`). It does not provide the wallet profile's required fail-closed ambiguity policy.
- The production secret flow uses one general scan. There is no independent second scan, modulo-rotation comparison, wallet-specific mismatch screen, backup-word verification, profile fingerprint, or clear-to-neutral completion step.

## Existing tests and fixed outputs

`web/src/tests/bip39.test.ts` contains:

- Eight standard 256-bit entropy ↔ 24-word BIP39 vectors.
- One direct-codec example round trip.
- Direct-codec round trips for the first 20 entries in `TestDiceKeys`; the source's `isRunningInCI` switch is currently hard-coded `false`, so the 20-vector slice also applies in CI.

It contains no fixed `{"purpose":"wallet"}` output, no `getSecretBip39ForRecipe` test, no exact-recipe regression, and no wallet rotation-invariance test.

Phase 0 adds five documentation-only public synthetic wallet baselines in `spec/test-vectors.json`. Each was checked against:

1. the generated upstream seeded-crypto WASM executed directly from the pinned public 0.3.0 source blob, and
2. a temporary independent Python calculation of the audited C++ BLAKE2b/HKDF behavior.

All four app-style physical rotations canonicalized to the same seed and produced the same entropy/mnemonic for all five. These five baselines are not yet the reviewed Phase 1 corpus: wallet-library fields and required edge cases remain incomplete, and the reference implementation is not yet committed.

## Additional correctness and product findings

- BIP39 is selectable for any 32-byte Secret, not only the wallet recipe.
- Wallet-purpose format selection is case-insensitive, but derivation is byte-sensitive. For example, purpose `WALLET` still selects BIP39 while producing different secret bytes from the frozen lowercase recipe.
- A prior user-selected Secret format overrides the wallet-purpose default, so selecting the built-in wallet recipe does not guarantee BIP39 output.
- A custom wallet-purpose Secret with non-32-byte length defaults internally to BIP39, while the selector hides that option and the conversion returns `undefined`, allowing an inconsistent blank state.
- The BIP39 parser does not trim leading/trailing whitespace and does not require exactly 24 words; hardening is needed if mnemonic import remains supported anywhere.
- The direct decoder is non-canonical: it ignores six trailing entropy bits, so 64 different checksum-valid 24-word mnemonics can decode to the same face arrangement.
- `CachedApiCalls` and its asynchronous BIP39 calculation cache retain response material in process memory without a wallet-specific clear method.
- Current Electron window construction explicitly sets `nodeIntegration: true` (`electron/src/trusted-main-electron-process/BrowserWindows.ts:22-32`).
- The production web entry point `web/src/index.html` has no CSP. The separate Electron renderer entry point `web/src/electron.html` has a policy that permits `unsafe-inline` and `unsafe-eval` and does not establish the wallet session's required restrictive `connect-src`.
- Core DiceKeys package lockfile entries report `NOT YET LICENSED` or `UNLICENSED`; distribution licensing requires resolution.

## Dormant and unfinished paths

- `toBip39Calculation` in `web/src/formats/bip39/bip39.ts:69-75` is unused.
- `diceKeyToBip39WordArray` at `bip39.ts:128-129` is unused.
- The direct encoder/decoder are test-only.
- `diceKeyFacesToSeedString` has stale comments about recipe-driven orientation exclusion even though the current function accepts no recipe parameter (`web/src/dicekeys/DiceKey/index.ts:57-80`).
- There is no named/frozen wallet profile, wallet-specific vector suite, PBKDF2 mnemonic-to-seed code, BIP32/BIP84 verification, or dedicated wallet recovery UI.

## Phase 0 gate result

Phase 0 is **closed** after independent read-only review found no remaining blocking documentation issue. Evidence captured:

- exact upstream commit recorded;
- both BIP39 mechanisms traced and separated;
- production reachability determined;
- current output reproduced for five synthetic DiceKeys and all four rotations;
- credential-free build blocker and all downstream non-runs recorded;
- no application behavior changed.

The approval covers this audit and the five Phase 0 compatibility anchors only. It does not approve the draft profile for implementation, imply that blocked application tests/builds passed, or authorize feature work. Phase 1 must approve the independent specification and full vector set first.
