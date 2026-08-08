# DK-BIP39-24-v1

Status: **non-normative Phase 0 draft; not approved for implementation or recovery**
Audited app commit: `4eac9aa7248d40891b2d77527c4c1db39e3c9285`
Audited JavaScript package: `@dicekeys/seeded-crypto-js` 0.3.0
Audited generated JavaScript/WASM source commit: `6abb040989f4ad0dce5026e08407425ff57a401e` (blob `a2e1b576c3ff15f665fd7adf9035ea092e0ba938`, unchanged at merge commit `cd8c87cf93199f2d8facd8b6a6b54a1c4b67626f`)
Generated JavaScript/WASM source SHA-256: `8a29007c11ebd0a0e8793089c6aa480633474d0336a41f0f4b248ef385b6d1ec`
Audited seeded-crypto source commit referenced by the public 0.3.0 source tree: `8e1d1965c1720b8964e3ee1880163f7a6b221781` (the inaccessible locked package tarball has not yet been compared)

This document records the behavior found during Phase 0. It becomes normative only after Phase 1 independent implementation and review.

## Compatibility target

```text
profile metadata: DK-BIP39-24-v1
input: canonical 75-character DiceKey seed string
derived object type: Secret
recipe UTF-8 text: {"purpose":"wallet"}
derived length: 32 bytes
hash function: upstream default BLAKE2b derivation
output: BIP39 English mnemonic, 24 words
```

The profile metadata is not part of the recipe.

## DiceKey serialization observed upstream

Each face is serialized as three ASCII/UTF-8 characters: uppercase face letter, digit `1` through `6`, then orientation `t`, `r`, `b`, or `l`. Faces are concatenated in row-major order.

To canonicalize, serialize the input in each of its four complete physical rotations, including the corresponding face-orientation changes, and select the lexicographically earliest 75-character string.

## Secret derivation observed upstream

The audited seeded-crypto source parses the recipe for parameters but also uses the original recipe string in the derivation input. For the exact v1 recipe:

```text
IKM  = UTF8(canonical DiceKey seed string)
info = UTF8("Secret" + "{\"purpose\":\"wallet\"}")
```

For the 32-byte BLAKE2b path used by this profile, the audited implementation performs:

```text
PRK = BLAKE2b-256(key = 32 zero bytes, message = IKM)
T1  = BLAKE2b-256(key = PRK, message = info || 0x01)
derivedEntropy = T1
```

Despite upstream source comments describing this as HKDF, this is not RFC 5869 HMAC-HKDF: both steps use libsodium keyed BLAKE2b directly, with no HMAC and no null separator. This description follows the exact audited source behavior and must be checked by an independent implementation in Phase 1.

Recipe whitespace, property order, case, or added fields are not normalized by seeded-crypto and therefore change `info` and the result. The application UI canonicalizes recipe JSON before making the call, but compatible recovery software must still use the exact recipe bytes above.

## BIP39 encoding observed upstream

1. Treat the 32-byte derived value as 256 bits of entropy.
2. Compute SHA-256 of those bytes and append the first 8 checksum bits.
3. Split the resulting 264 bits into 24 consecutive 11-bit unsigned indices.
4. Map the indices to the BIP39 English list.
5. Join words with one ASCII space.

No BIP39 passphrase is part of this profile.

## Compatibility promise proposed for Phase 1

Every compliant implementation of `DK-BIP39-24-v1` must reproduce the existing DiceKeys `Secret` derivation using the exact recipe string `{"purpose":"wallet"}`. No future software update may silently alter this profile.

## Unresolved before approval

- Freeze complete input validation, including duplicate-letter policy and scanner ambiguity handling.
- Confirm the derivation with the exact upstream WASM package and an independent reviewer.
- Acquire the locked GitHub Package tarball and verify it against the audited public generated-source blob; anonymous and current-session downloads were blocked by package authentication during Phase 0.
- Expand `spec/test-vectors.json` from the Phase 0 five-vector baseline to at least 20 reviewed vectors.
- Add BIP39 seed, BIP32 fingerprint, and BIP84 address fields verified by independent libraries.
- Publish and review a standalone Python implementation.
- Record the final reversible-codec disposition.
