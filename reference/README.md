# Wallet recovery reference implementations

These are standalone recovery references for the byte-level profile in
[`../spec/DK-BIP39-24-v1.md`](../spec/DK-BIP39-24-v1.md). Neither implementation
imports the DiceKeys application, its TypeScript modules, seeded-crypto WASM, or
third-party packages.

Do not put a real DiceKey, mnemonic, or funded-wallet secret into a shared
terminal, CI log, issue, or test fixture. The committed fixtures are synthetic.

## Run

Python 3 uses only the standard library:

```sh
python3 reference/dk_bip39_24_v1.py --self-test
python3 reference/dk_bip39_24_v1.py '<75-character-DiceKey-HRF>'
```

The TypeScript file deliberately stays within JavaScript-compatible TypeScript,
so the pinned Node 22 runtime can execute it without transpilation:

```sh
node reference/dk_bip39_24_v1.ts --self-test
node reference/dk_bip39_24_v1.ts '<75-character-DiceKey-HRF>'
```

Each CLI emits JSON containing `profile`, `canonicalSeedString`,
`derivedEntropyHex`, and `mnemonic`. Invalid input exits with status 2 and emits
no partial result. The stderr prefix includes one stable profile code:
`NON_ASCII`, `INVALID_LENGTH`, `INVALID_LETTER`, `INVALID_DIGIT`,
`INVALID_ORIENTATION`, or `DUPLICATE_OR_MISSING_LETTER`.

The reference CLIs intentionally emit only those four profile fields. BIP39
seed, BIP32 fingerprint, and BIP84 address fields in the conformance vectors
are downstream wallet-library verification metadata, not outputs of this
profile or these CLIs.

Run the cross-implementation tests with:

```sh
python3 -m unittest discover -s reference -p 'test_*.py' -v
```

The built-in self-tests exercise an RFC 7693 BLAKE2b vector, a keyed
BLAKE2b-256 check, a standard 256-bit BIP39 case, every committed valid vector
and physical rotation, every committed malformed-input/error-code case, and the
scanner ambiguity policy metadata. The frozen Phase 1 corpus contains 27 valid
vectors (including the five historical Phase 0 anchors), 108 physical-rotation
derivations, and 13 invalid cases. The cross-implementation test checks every
one of them.

## Recovery profile check code v1

The presentation-only check code is specified separately in
[`../spec/RecoveryProfileCheckCode-v1.md`](../spec/RecoveryProfileCheckCode-v1.md).
It does not change `DK-BIP39-24-v1`, expose BIP32 metadata, or act as
authentication. Run the independent references with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B reference/recovery_profile_check_code_v1.py
node reference/recovery_profile_check_code_v1.ts --self-test
```

Both references verify the exact domain/profile preimage, all 27 public
mnemonics and 108 rotation associations, strict canonical mnemonic input, the
full SHA-256 digests, and the formatted 48-bit codes. The combined unittest
discovery command above currently runs 10 tests across the derivation-profile
and recovery-check-code references.

## TypeScript BLAKE2b note

The Node 20 `crypto.createHash("blake2b512", { key })` interface must not be used
for this profile. In the audited environment it ignored `key`; `outputLength:
32` failed, and `digestLength: 32` was ignored. Truncating a 64-byte BLAKE2b
digest is also incorrect because BLAKE2b incorporates the requested digest
length into its parameter block. The TypeScript reference therefore contains a
small RFC 7693 implementation and requests a 32-byte digest at initialization.

## BIP39 English asset provenance

`bip39-english.txt` is the canonical BIP39 English list from the Bitcoin BIPs
repository, not an application-owned word list:

- source commit: `ed4ffcb6a48d4dc4fdfc11cdba783c233db8c66e`
- source path: `bip-0039/english.txt`
- Git blob: `942040ed50f7205cafc465496229128ba4f78e75`
- file size: 13,116 bytes; 2,048 LF-terminated ASCII words
- SHA-256: `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`
- pinned source: <https://github.com/bitcoin/bips/blob/ed4ffcb6a48d4dc4fdfc11cdba783c233db8c66e/bip-0039/english.txt>

Both references verify the exact asset hash before producing a mnemonic.
