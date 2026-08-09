#!/usr/bin/env python3
"""Independent standard-library reference for Recovery profile check code v1."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


REFERENCE_DIR = Path(__file__).resolve().parent
REPOSITORY_DIR = REFERENCE_DIR.parent
PROFILE_ID = "DK-BIP39-24-v1"
LABEL = "Recovery profile check code v1"
DOMAIN_ASCII = "DiceKeys/RecoveryProfileCheckCode/v1"
PREFIX = DOMAIN_ASCII.encode("ascii") + b"\x00" + PROFILE_ID.encode("ascii") + b"\x00"
PREFIX_HEX = (
    "446963654b6579732f5265636f7665727950726f66696c65436865636b436f6465"
    "2f763100444b2d42495033392d32342d763100"
)
WORD_LIST_PATH = REFERENCE_DIR / "bip39-english.txt"
SOURCE_VECTORS_PATH = REPOSITORY_DIR / "spec" / "test-vectors.json"
CHECK_CODE_VECTORS_PATH = (
    REPOSITORY_DIR / "spec" / "recovery-profile-check-code-v1-test-vectors.json"
)
WORD_LIST_BYTES = WORD_LIST_PATH.read_bytes()
WORDS = tuple(WORD_LIST_BYTES.decode("ascii").splitlines())
WORD_INDEX = {word: index for index, word in enumerate(WORDS)}
CANONICAL_MNEMONIC_RE = re.compile(r"[a-z]+(?: [a-z]+){23}", re.ASCII)


class CheckCodeInputError(ValueError):
    """A candidate is not the exact canonical 24-word wallet mnemonic."""


def validate_canonical_mnemonic(candidate: object) -> str:
    if not isinstance(candidate, str) or CANONICAL_MNEMONIC_RE.fullmatch(candidate) is None:
        raise CheckCodeInputError("mnemonic must be exactly 24 lowercase ASCII words")
    words = candidate.split(" ")
    try:
        indexes = [WORD_INDEX[word] for word in words]
    except KeyError as error:
        raise CheckCodeInputError("mnemonic contains a non-BIP39-English word") from error

    encoded = 0
    for index in indexes:
        encoded = (encoded << 11) | index
    entropy = (encoded >> 8).to_bytes(32, "big")
    checksum = encoded & 0xFF
    if hashlib.sha256(entropy).digest()[0] != checksum:
        raise CheckCodeInputError("mnemonic has an invalid BIP39 checksum")
    return candidate


def _digest_for_profile(profile: str, mnemonic: str) -> bytes:
    """Negative-control primitive; the public profile path remains fixed."""
    preimage = (
        DOMAIN_ASCII.encode("ascii")
        + b"\x00"
        + profile.encode("ascii")
        + b"\x00"
        + mnemonic.encode("ascii")
    )
    return hashlib.sha256(preimage).digest()


def derive_check_code(mnemonic: object) -> dict[str, str]:
    canonical = validate_canonical_mnemonic(mnemonic)
    digest = hashlib.sha256(PREFIX + canonical.encode("ascii")).digest()
    check_code_hex = digest[:6].hex().upper()
    return {
        "fullDigestHex": digest.hex(),
        "checkCodeHex": check_code_hex,
        "displayCheckCode": "-".join(
            check_code_hex[offset : offset + 4] for offset in range(0, 12, 4)
        ),
    }


def _load_documents() -> tuple[dict[str, object], dict[str, object]]:
    return (
        json.loads(SOURCE_VECTORS_PATH.read_text(encoding="utf-8")),
        json.loads(CHECK_CODE_VECTORS_PATH.read_text(encoding="utf-8")),
    )


def all_vector_results() -> dict[str, dict[str, str]]:
    source, expected = _load_documents()
    ids = source["validVectorIdsInOrder"]
    vectors = source["vectors"]
    if not isinstance(ids, list) or not isinstance(vectors, list) or len(ids) != len(vectors):
        raise AssertionError("source vector IDs and mnemonic records are not aligned")
    results = {
        vector_id: derive_check_code(vector["mnemonic"])
        for vector_id, vector in zip(ids, vectors, strict=True)
    }
    if list(results) != list(expected["vectors"]):
        raise AssertionError("check-code vector keys do not match the source vector order")
    return results


def run_self_test() -> tuple[int, int]:
    source, expected = _load_documents()
    assert len(WORDS) == 2048
    assert LABEL == expected["label"]
    assert PROFILE_ID == expected["profile"]
    assert DOMAIN_ASCII == expected["domainAscii"]
    assert PREFIX.hex() == PREFIX_HEX == expected["preimagePrefixHex"]
    assert expected["digestAlgorithm"] == "SHA-256"
    assert expected["codeByteLength"] == 6
    assert expected["bip39EnglishWordList"] == {
        "entryCount": len(WORDS),
        "lfTerminatedAsciiByteLength": len(WORD_LIST_BYTES),
        "lfTerminatedAsciiSha256": hashlib.sha256(WORD_LIST_BYTES).hexdigest(),
    }

    results = all_vector_results()
    assert len(results) == expected["vectorCount"] == 27
    rotation_associations = 0
    for vector_id, vector in zip(
        source["validVectorIdsInOrder"], source["vectors"], strict=True
    ):
        result = results[vector_id]
        assert result == expected["vectors"][vector_id]
        assert len(vector["allFourRotations"]) == 4
        for _rotation in vector["allFourRotations"]:
            assert derive_check_code(vector["mnemonic"]) == result
            rotation_associations += 1
    assert rotation_associations == expected["physicalRotationAssociationCount"] == 108

    v01_mnemonic = source["vectors"][0]["mnemonic"]
    assert results["V01"] == {
        "fullDigestHex": "521cbb8cfd07d4e44f94d70c2af68d2606bab17317de71553100af1488cde7cd",
        "checkCodeHex": "521CBB8CFD07",
        "displayCheckCode": "521C-BB8C-FD07",
    }
    changed_profile = expected["negativeControls"]["changedProfileForV01"]
    changed_profile_digest = _digest_for_profile(
        changed_profile["profile"], v01_mnemonic
    )
    assert changed_profile_digest.hex() == changed_profile["fullDigestHex"]
    assert changed_profile_digest != bytes.fromhex(results["V01"]["fullDigestHex"])

    assert results["V23"] != results["V24"]
    assert results["V25"] != results["V26"]
    for candidate in (
        " " + v01_mnemonic,
        v01_mnemonic + " ",
        v01_mnemonic.replace(" ", "  ", 1),
        v01_mnemonic.replace(" ", "\t", 1),
        v01_mnemonic.replace(" ", "\n", 1),
        v01_mnemonic.replace(" ", "\u00a0", 1),
        v01_mnemonic.replace("execute", "Execute", 1),
    ):
        try:
            derive_check_code(candidate)
        except CheckCodeInputError:
            pass
        else:
            raise AssertionError("non-canonical mnemonic encoding was accepted")
    return len(results), rotation_associations


if __name__ == "__main__":
    vector_count, association_count = run_self_test()
    print(
        f"ok: {vector_count} check-code vectors and "
        f"{association_count} rotation associations matched"
    )
