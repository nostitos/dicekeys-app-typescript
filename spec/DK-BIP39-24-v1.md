# DK-BIP39-24-v1

- Status: **normative profile specification; Phase 1 review candidate**
- Version: 1.0
- Date: 2026-08-08
- Profile identifier: `DK-BIP39-24-v1`

This document freezes a recovery-compatible mapping from one valid physical
DiceKey to one 24-word BIP39 English mnemonic. The words **MUST**, **MUST NOT**,
**SHOULD**, and **SHOULD NOT** are normative requirements.

The profile identifier is metadata. It is never inserted into the recipe or
any cryptographic input.

## 1. Scope and compatibility promise

The profile is:

```text
validated 25-face DiceKey
  -> canonical 75-byte DiceKey seed string
  -> seeded-crypto Secret-compatible keyed-BLAKE2b derivation
  -> 32 bytes
  -> BIP39 English encoding
  -> 24 words
```

Every compliant implementation of `DK-BIP39-24-v1` MUST reproduce the existing
DiceKeys `Secret` derivation using the exact recipe string
`{"purpose":"wallet"}`. No future software update may silently alter this
profile. A change to any normative byte, validation rule, canonicalization
rule, KDF operation, word list, or output format requires a new profile
identifier.

This profile ends at the mnemonic. It does not define a blockchain, wallet
account, BIP32 path, address type, network, hardware-wallet protocol, or BIP39
passphrase.

## 2. Frozen parameters

| Parameter | Normative value |
| --- | --- |
| Face count | exactly 25 in a 5 by 5 grid |
| Face order | row-major, left-to-right then top-to-bottom |
| Allowed letters | `ABCDEFGHIJKLMNOPRSTUVWXYZ`, each exactly once |
| Allowed digits | `1` through `6` |
| Allowed orientations | `t`, `r`, `b`, `l` |
| HRF encoding | exactly 75 ASCII bytes; UTF-8 is byte-identical |
| Physical rotations | 0, 1, 2, and 3 clockwise quarter-turns |
| Canonical choice | bytewise lexicographically earliest rotated HRF |
| Seeded object type | `Secret` |
| Recipe text | `{"purpose":"wallet"}` |
| Recipe UTF-8 hex | `7b22707572706f7365223a2277616c6c6574227d` |
| KDF | the two keyed BLAKE2b-256 calls in section 6 |
| Derived length | exactly 32 bytes |
| Mnemonic standard | BIP39, English list only |
| Mnemonic size | exactly 24 words |
| Mnemonic separator | one ASCII space (`0x20`) |

`Q` is not a DiceKey face letter and is invalid.

## 3. Core input and fail-closed validation

### 3.1 Human-readable form

The core input is one fully resolved DiceKey human-readable form (HRF). It has
25 consecutive three-character faces:

```text
face = letter digit orientation
HRF  = face repeated exactly 25 times
```

For example, `A3r` is face letter `A`, digit `3`, oriented right. Face 0 is the
top-left grid cell; face 24 is the bottom-right grid cell.

### 3.2 Required validation

Before canonicalization or derivation, an implementation MUST verify all of the
following:

1. The input is a string encodable as ASCII without replacement.
2. Its ASCII/UTF-8 encoding is exactly 75 bytes.
3. Each letter is in `ABCDEFGHIJKLMNOPRSTUVWXYZ`.
4. Each digit is in `123456`.
5. Each orientation is in `trbl` and is lowercase.
6. Every allowed letter occurs exactly once.

Failure of any check MUST stop processing without returning a canonical seed,
entropy, or mnemonic. Implementations MUST NOT trim whitespace, change case,
apply Unicode normalization, replace unknown characters, or infer a missing
letter. In particular, `?` is not an orientation and duplicate letters are not
repairable input. Repeated digits and repeated orientations are valid; only the
25 face letters are required to be unique.

### 3.3 Stable validation error taxonomy

Machine-verifiable implementations and conformance vectors use these exact,
case-sensitive error codes:

| Code | Meaning |
| --- | --- |
| `NON_ASCII` | The string contains any non-ASCII character. |
| `INVALID_LENGTH` | The ASCII string is not exactly 75 bytes, including truncated, extra, or wrong-face-count forms. |
| `INVALID_LETTER` | A face letter is outside `ABCDEFGHIJKLMNOPRSTUVWXYZ`, including `Q`, lowercase, or an unknown marker. |
| `INVALID_DIGIT` | A face digit is outside `1` through `6`. |
| `INVALID_ORIENTATION` | A face orientation is outside lowercase `t`, `r`, `b`, `l`, including `?`. |
| `DUPLICATE_OR_MISSING_LETTER` | All face triples are otherwise valid, but the required letter set does not occur exactly once. |

If an input violates more than one rule, implementations MUST apply this
precedence: `NON_ASCII`, then `INVALID_LENGTH`, then scan face triples from
left to right checking letter, digit, and orientation in that order, then check
the complete letter set for `DUPLICATE_OR_MISSING_LETTER`.

These codes describe HRF validation. A non-string value is an API type error,
not a profile input. Scanner acquisition uses the separate
`AMBIGUOUS_SCAN` state described below and MUST NOT manufacture an HRF merely
to obtain a core validation code.

## 4. Scanner and acquisition boundary

Image acquisition is outside the cryptographic core. A scanner integration
MUST convert an image into one fully resolved HRF before calling the profile.
It MUST NOT submit probability distributions, alternate candidates, unknown
orientations, underline/overline error states, or partially filled faces to the
core.

For wallet generation, acquisition MUST fail closed:

- Every face letter, digit, and orientation MUST have one explicit resolved
  value.
- Any ambiguity MUST be surfaced to the user as an ambiguity, with the affected
  face identified.
- The user MUST re-scan or explicitly correct/confirm the affected value before
  derivation resumes.
- A scanner MUST NOT choose a "best guess," silently use the most probable
  candidate, or exploit the one-of-each-letter rule to auto-repair a duplicate
  and missing letter.

The stable acquisition-layer code/state for any unresolved scanner candidate is
`AMBIGUOUS_SCAN`. It is not a seventh HRF validation code: while it is active,
the scanner MUST produce no HRF and MUST NOT invoke canonicalization or
derivation. If an integration incorrectly serializes an unknown marker such as
`?`, the core still rejects it with the applicable `INVALID_*` code.

Manual entry and scanner output pass through the same core validation. An
application may impose stricter acquisition controls, such as two independent
matching scans; such controls do not change this profile's bytes.

## 5. Rotation-independent canonicalization

### 5.1 Face rotation

Let `R0[r,c]`, for `r,c` in `0..4`, be the validated input grid. Define
successive clockwise physical rotations by:

```text
R(k+1)[r,c].letter      = Rk[4-c,r].letter
R(k+1)[r,c].digit       = Rk[4-c,r].digit
R(k+1)[r,c].orientation = rotate_orientation(Rk[4-c,r].orientation, 1)
```

The orientation cycle is:

```text
t -> r -> b -> l -> t
```

Equivalently, assign `t=0`, `r=1`, `b=2`, `l=3` and add the number of
clockwise quarter-turns modulo 4. For one clockwise turn, output positions use
these input indexes:

```text
20 15 10  5  0
21 16 11  6  1
22 17 12  7  2
23 18 13  8  3
24 19 14  9  4
```

Applying that operation zero, one, two, and three times produces `R0`, `R1`,
`R2`, and `R3`. Face orientations remain part of every candidate.

### 5.2 Serialization and selection

Serialize each rotated grid in row-major order. Each face contributes exactly
its letter byte, digit byte, and orientation byte, with no delimiter:

```text
Sk = concat(Rk[0,0].letter, Rk[0,0].digit, Rk[0,0].orientation,
            ...,
            Rk[4,4].letter, Rk[4,4].digit, Rk[4,4].orientation)
```

Each `Sk` is exactly 75 ASCII bytes. Select:

```text
canonicalSeedString = min_lexicographic(S0, S1, S2, S3)
```

Comparison MUST be unsigned bytewise lexicographic comparison over the complete
75-byte strings. Since every character is ASCII, ordinary ASCII/UTF-8
lexicographic order is identical. No NUL, newline, BOM, length prefix, or other
separator is appended.

Consequently, providing any complete physical rotation of one valid DiceKey
MUST produce the same `canonicalSeedString` and final mnemonic.

## 6. Secret derivation

### 6.1 Exact byte strings

Define:

```text
IKM        = ASCII(canonicalSeedString)             # exactly 75 bytes
objectType = ASCII("Secret")                        # 6 bytes
recipe     = UTF8("{\"purpose\":\"wallet\"}")          # 20 bytes
info       = objectType || recipe                   # 26 bytes
counter    = 0x01                                   # one byte
zeroKey    = 0x00 repeated 32 times                 # a real 32-byte key
```

The exact `info` hex is:

```text
5365637265747b22707572706f7365223a2277616c6c6574227d
```

There is no delimiter or NUL byte between `Secret` and the recipe. Recipe
whitespace, field ordering, case, or additional fields are not normalized.
Adding `"type"`, `"lengthInBytes"`, the profile identifier, or any other
metadata to the recipe produces a different derivation and is non-conformant.

### 6.2 BLAKE2b-256 primitive

Let `B2_32(key, message)` mean keyed BLAKE2b as specified by RFC 7693, with:

- digest length exactly 32 bytes;
- key length exactly 32 bytes;
- sequential mode (`fanout = 1`, `depth = 1`);
- leaf length, node offset, node depth, inner length, salt, and personalization
  all zero/empty;
- the standard BLAKE2b IV, 128-byte block size, little-endian words, and 12
  compression rounds.

Thus, the first eight parameter bytes are `20 20 01 01 00 00 00 00`, and all
remaining parameter bytes are zero. The key MUST be supplied through BLAKE2b's
keyed mode, including its key-length parameter and padded key block. It MUST NOT
be prepended to the message, treated as an HMAC key, omitted when all-zero, or
used with a 64-byte digest that is later truncated. BLAKE2b incorporates digest
length into its parameter block, so truncating BLAKE2b-512 is not equivalent.

### 6.3 Two-call construction

Compute exactly:

```text
PRK            = B2_32(key = zeroKey, message = IKM)
derivedEntropy = B2_32(key = PRK,     message = info || counter)
```

`derivedEntropy` is the complete 32-byte result. No further block, truncation,
padding, iteration, or post-processing is performed.

The upstream function and comments call this construction HKDF, but it is **not
RFC 5869 HMAC-HKDF**. Both calls use keyed BLAKE2b directly. Implementations
MUST reproduce the equations above rather than substitute an HKDF API.

## 7. BIP39 English encoding

Treat `derivedEntropy` as 256 bits in byte order. Compute:

```text
checksum = first 8 bits of SHA-256(derivedEntropy)
bits     = derivedEntropy bits || checksum
```

Read both the entropy and checksum most-significant bit first. Split the 264-bit
result from left to right into 24 consecutive 11-bit unsigned integers. Use
each integer as a zero-based index into the canonical 2,048-word BIP39 English
list. Join the 24 lowercase words with exactly one ASCII space (`0x20`), with no
leading or trailing whitespace.

The canonical list for this profile is the Bitcoin BIPs file
`bip-0039/english.txt` at commit
`ed4ffcb6a48d4dc4fdfc11cdba783c233db8c66e`, Git blob
`942040ed50f7205cafc465496229128ba4f78e75`. The exact LF-terminated asset is
13,116 bytes and has SHA-256:

```text
2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
```

The pinned source is
<https://github.com/bitcoin/bips/blob/ed4ffcb6a48d4dc4fdfc11cdba783c233db8c66e/bip-0039/english.txt>.
A conforming implementation MUST use this exact ordered word sequence.

No BIP39 passphrase participates in this profile. If conformance vectors include
`bip39SeedWithEmptyPassphraseHex`, BIP32 fingerprints, or addresses, those are
downstream verification fields computed with an explicitly empty passphrase;
they are not additional profile outputs. A user who later chooses a non-empty
BIP39 passphrase must preserve it separately to recover that downstream wallet.

## 8. Normative algorithm summary

```text
derive_DK_BIP39_24_v1(hrf):
    faces = validate_exactly_25_faces_and_unique_allowed_letters(hrf)
    rotations = [serialize(rotate(faces, k)) for k in (0, 1, 2, 3)]
    canonicalSeedString = bytewise_min(rotations)

    PRK = B2_32(0x00 * 32, ASCII(canonicalSeedString))
    derivedEntropy = B2_32(
        PRK,
        ASCII("Secret") || UTF8("{\"purpose\":\"wallet\"}") || 0x01
    )

    checksum = SHA256(derivedEntropy)[0]
    indexes = split_msb_first_into_24_unsigned_11_bit_values(
        derivedEntropy || checksum
    )
    mnemonic = join_with_single_ASCII_spaces(BIP39_ENGLISH[indexes])
    return canonicalSeedString, derivedEntropy, mnemonic
```

## 9. Worked compatibility anchor

For the first synthetic Phase 0 anchor:

```text
input HRF:
M2rU2lJ1bH5tK4lD2bI2bB4bF2rX1bC6lR2tO1tP4rG1bS4tN4lY1rE3tL1tZ6lV6lA3lW4lT5r

canonicalSeedString:
K4bX1rG1rL1lT5tH5lF2tP4tE3lW4bJ1rB4rO1lY1tA3bU2bI2rR2lN4bV6bM2tD2rC6bS4lZ6b

PRK:
b6f9d0e83126a6a0c985b3d97d1962c5cd21d7faa85316588ff76dff5550513c

derivedEntropy:
4f2ffae92b02020369c5c21106e48cb838d72886df4ca03ed107f4cac3e46631

SHA-256 checksum byte:
d0

BIP39 indexes:
633 1022 1490 688 257 13 1336 1474 136 441 281 899 1131 1186 219 1868 1281 1972 527 1868 1377 1937 1222 464

mnemonic:
execute lemon ripple figure cage accuse poem reunion baby damp case idea miracle nephew bread trumpet parent walk draft trumpet promote vendor occur deliver
```

All four HRFs representing physical rotations of this anchor MUST produce these
same canonical and derived values.

## 10. Conformance and error behavior

A conforming implementation MUST:

1. implement the validation, rotation, byte encoding, KDF, and BIP39 rules in
   this document;
2. match every valid vector in `spec/test-vectors.json` byte-for-byte;
3. derive the same result for all four rotations in each vector;
4. reject every committed `invalidCases` input with its exact
   `expectedErrorCode`;
5. return no partial cryptographic output after validation failure;
6. keep the profile identifier out of the recipe and KDF input; and
7. if it includes scanner acquisition, satisfy every committed
   `acquisitionPolicyCases` result without invoking profile derivation.

Lowercase hexadecimal with no prefix is the required representation for byte
fields in conformance artifacts. Hex formatting is not an additional input to
the derivation.

The implementations in `reference/` are informative executable aids. This
document and the committed vectors control conformance if implementation code
and prose ever disagree.

## 11. Compatibility boundary with the reversible DiceKey codec

The upstream repository also contains a direct codec that packs a viewed
DiceKey layout into BIP39-shaped words and can decode those words back into a
layout. It is rotation-dependent and does not use the `Secret` derivation in
this profile. Its words are **not** `DK-BIP39-24-v1` wallet recovery words.

Disposition: retain the encoder and decoder internally for legacy recovery.
When its code area is changed, rename the implementation to an explicit legacy
layout name such as `legacyReversibleDiceKeyLayoutEncoding`, preserve deprecated
compatibility aliases and fixed legacy round-trip vectors, and keep it
unreachable from the wallet API and wallet interface. It MUST NOT be labeled or
displayed as wallet recovery. Removal requires maintainer confirmation, a
documented migration window, and a separate consumer/compatibility decision.

## 12. Security and compatibility bounds

- A uniformly random valid DiceKey under these rules has at most
  `log2(25! * 6^25 * 4^25 / 4)`, approximately **196.31 bits**, after four-way
  rotation equivalence. Encoding the result in a 256-bit BIP39 entropy field
  does not create 256 bits of source entropy. Manufacturing, selection,
  handling, or scanning bias can lower the real security further.
- The BLAKE2b construction is intentionally fast and is not password
  stretching. Security depends on a genuinely random, secret DiceKey, not a
  user-chosen or predictable HRF.
- The 8-bit BIP39 checksum detects many transcription errors but is not a MAC,
  signature, or proof that the correct DiceKey was scanned.
- The canonicalization step removes only physical whole-key rotation. It does
  not repair a face, omit orientations, or make ambiguous scanner output safe.
- The mnemonic, derived entropy, canonical HRF, and original DiceKey are all
  sensitive recovery material. Implementations SHOULD avoid logs, telemetry,
  clipboard use, network transmission, persistent caches, and unnecessary
  copies. Managed-language erasure guarantees are inherently limited.
- Anyone who obtains the mnemonic can attempt to recover downstream wallets.
  Implementations SHOULD verify backups offline and clear the active view and
  transient state after use.

## 13. Provenance

This compatibility target was audited from:

- DiceKeys app commit `4eac9aa7248d40891b2d77527c4c1db39e3c9285`;
- `@dicekeys/seeded-crypto-js` version `0.3.0` source commit
  `6abb040989f4ad0dce5026e08407425ff57a401e`;
- generated JavaScript/WASM blob
  `a2e1b576c3ff15f665fd7adf9035ea092e0ba938`, SHA-256
  `8a29007c11ebd0a0e8793089c6aa480633474d0336a41f0f4b248ef385b6d1ec`;
- seeded-crypto C++ commit
  `8e1d1965c1720b8964e3ee1880163f7a6b221781`, especially
  [`hkdf.cpp`](https://github.com/dicekeys/seeded-crypto/blob/8e1d1965c1720b8964e3ee1880163f7a6b221781/lib-seeded/hkdf.cpp)
  and
  [`recipe.cpp`](https://github.com/dicekeys/seeded-crypto/blob/8e1d1965c1720b8964e3ee1880163f7a6b221781/lib-seeded/recipe.cpp).

The authenticated package tarball pinned by the app lockfile was unavailable in
the Phase 0 credential-free environment, so its bytes were not compared with
the public generated-source blob. Historically, the five Phase 0 anchors were
matched independently against that public pinned WASM and the byte-level
construction specified here. The current Phase 1 corpus expands this evidence
to 27 valid vectors and all 108 physical-rotation derivations; the frozen vector
artifact records parity with the public pinned WASM, and both standalone
references reproduce all 108 results. Package provenance remains a supply-chain
release check; it does not permit an implementation to vary this frozen
profile.
