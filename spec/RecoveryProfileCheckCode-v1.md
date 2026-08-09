# Recovery profile check code v1

Status: Phase 4 review candidate

## Purpose and limits

The recovery profile check code is a short, deterministic association aid. It
helps a person notice that a set of recovery words is being paired with the
expected DiceKeys wallet profile. For an unrelated candidate, an accidental
48-bit match has probability `2^-48` (about one in 281 trillion), assuming the
truncated SHA-256 values behave uniformly.

The code is **not authentication**, a proof of possession, a secret, a unique
wallet identifier, or a substitute for verifying recovery words. An attacker
who knows or guesses the mnemonic can compute the same code.

The same profile and mnemonic always produce the same code. That stability can
link the same wallet across documents, devices, sessions, or identities. Do not
publish the code or store it with identifying information unless that
linkability is acceptable.

The code deliberately excludes the BIP39 passphrase, Bitcoin network, BIP32
path, addresses, and account state. It therefore cannot detect a passphrase or
network mismatch.

## Frozen contract

| Field | Exact value |
|---|---|
| Label | `Recovery profile check code v1` |
| Domain ASCII | `DiceKeys/RecoveryProfileCheckCode/v1` |
| Profile ASCII | `DK-BIP39-24-v1` |
| Separator | one zero byte (`00`) |
| Digest | SHA-256 |
| Truncation | first 6 digest bytes (48 bits) |
| Display | uppercase hexadecimal, grouped `4-4-4` as `XXXX-XXXX-XXXX` |

The preimage is the following byte concatenation, with no terminator:

```text
ASCII(domain) || 0x00 || ASCII(profile) || 0x00 || ASCII(canonicalMnemonic)
```

The fixed prefix, through the second zero separator, is exactly:

```text
446963654b6579732f5265636f7665727950726f66696c65436865636b436f64652f763100444b2d42495033392d32342d763100
```

The canonical mnemonic MUST contain exactly 24 words from the frozen BIP39
English word list. Its BIP39 checksum MUST be valid. Every word MUST already be
lowercase ASCII, and the serialized mnemonic MUST be the words joined by one
ASCII space. Leading or trailing whitespace, repeated spaces, tabs, line
breaks, Unicode whitespace, case changes, and Unicode normalization are
rejected rather than normalized.

The production helper MUST NOT accept a raw mnemonic or a caller-supplied
domain, profile, passphrase, network, BIP32 path, or truncation length. It
accepts only the Phase 3 structured wallet result. That result is accepted only
when it has the exact `profileId`, `words`, and `mnemonic` fields, both the
result and word array are immutable, and its words reconstruct the canonical
mnemonic exactly. Standalone conformance references may accept a raw canonical
mnemonic so they can recompute the frozen vectors independently.

## Fixed example

For vector `V01` in `test-vectors.json`:

```text
SHA-256 = 521cbb8cfd07d4e44f94d70c2af68d2606bab17317de71553100af1488cde7cd
Code    = 521C-BB8C-FD07
```

All 27 full digests and display codes are frozen separately in
`recovery-profile-check-code-v1-test-vectors.json`. The mnemonic remains sourced
from the Phase 1 corpus; the check-code artifact does not modify or duplicate
that corpus. Each vector's four physical rotations share its one canonical
mnemonic and therefore its one check code, covering 108 rotation associations.
