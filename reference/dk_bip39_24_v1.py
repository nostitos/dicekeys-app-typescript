#!/usr/bin/env python3
"""Independent reference implementation of DK-BIP39-24-v1.

This module intentionally shares no DiceKeys application code.  It uses only
the Python standard library and the canonical word-list asset beside it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence


PROFILE_ID: Final = "DK-BIP39-24-v1"
FACE_LETTERS: Final = "ABCDEFGHIJKLMNOPRSTUVWXYZ"
FACE_DIGITS: Final = "123456"
FACE_ORIENTATIONS: Final = "trbl"
RECIPE_BYTES: Final = b'{"purpose":"wallet"}'
OBJECT_TYPE_BYTES: Final = b"Secret"
DERIVATION_INFO: Final = OBJECT_TYPE_BYTES + RECIPE_BYTES
WORD_LIST_PATH: Final = Path(__file__).with_name("bip39-english.txt")
WORD_LIST_SHA256: Final = (
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
)
VECTORS_PATH: Final = Path(__file__).parent.parent / "spec" / "test-vectors.json"
VALIDATION_ERROR_PRECEDENCE: Final = (
    "NON_ASCII",
    "INVALID_LENGTH",
    "INVALID_LETTER",
    "INVALID_DIGIT",
    "INVALID_ORIENTATION",
    "DUPLICATE_OR_MISSING_LETTER",
)
VALIDATION_ERROR_CODES: Final = frozenset(VALIDATION_ERROR_PRECEDENCE)

# For an output position in each clockwise rotation, the corresponding input
# position.  Positions are row-major in a 5 by 5 grid.
ROTATION_INDEXES: Final = (
    tuple(range(25)),
    (
        20, 15, 10, 5, 0,
        21, 16, 11, 6, 1,
        22, 17, 12, 7, 2,
        23, 18, 13, 8, 3,
        24, 19, 14, 9, 4,
    ),
    (
        24, 23, 22, 21, 20,
        19, 18, 17, 16, 15,
        14, 13, 12, 11, 10,
        9, 8, 7, 6, 5,
        4, 3, 2, 1, 0,
    ),
    (
        4, 9, 14, 19, 24,
        3, 8, 13, 18, 23,
        2, 7, 12, 17, 22,
        1, 6, 11, 16, 21,
        0, 5, 10, 15, 20,
    ),
)


class ProfileInputError(ValueError):
    """Raised when a DiceKey HRF is not valid for this profile."""

    def __init__(self, code: str, message: str) -> None:
        if code not in VALIDATION_ERROR_CODES:
            raise ValueError(f"unknown profile validation error code: {code}")
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Face:
    letter: str
    digit: str
    orientation: str


def parse_dicekey_hrf(human_readable_form: str) -> tuple[Face, ...]:
    """Validate and parse one resolved 75-byte DiceKey HRF, failing closed."""
    if not isinstance(human_readable_form, str):
        raise TypeError("DiceKey human-readable form must be a string")
    try:
        encoded = human_readable_form.encode("ascii")
    except UnicodeEncodeError as error:
        raise ProfileInputError(
            "NON_ASCII", "DiceKey human-readable form must be ASCII"
        ) from error
    if len(encoded) != 75:
        raise ProfileInputError(
            "INVALID_LENGTH",
            "DiceKey human-readable form must be exactly 75 bytes",
        )

    faces: list[Face] = []
    for position in range(25):
        offset = position * 3
        letter, digit, orientation = human_readable_form[offset : offset + 3]
        face_number = position + 1
        if letter not in FACE_LETTERS:
            raise ProfileInputError(
                "INVALID_LETTER", f"face {face_number} has an invalid letter"
            )
        if digit not in FACE_DIGITS:
            raise ProfileInputError(
                "INVALID_DIGIT", f"face {face_number} has an invalid digit"
            )
        if orientation not in FACE_ORIENTATIONS:
            raise ProfileInputError(
                "INVALID_ORIENTATION",
                f"face {face_number} has an invalid orientation",
            )
        faces.append(Face(letter, digit, orientation))

    letters = [face.letter for face in faces]
    if len(set(letters)) != 25 or set(letters) != set(FACE_LETTERS):
        raise ProfileInputError(
            "DUPLICATE_OR_MISSING_LETTER",
            "face letters must contain ABCDEFGHIJKLMNOPRSTUVWXYZ exactly once"
        )
    return tuple(faces)


def serialize_faces(faces: Sequence[Face]) -> str:
    if len(faces) != 25:
        raise ProfileInputError(
            "INVALID_LENGTH", "a DiceKey must contain exactly 25 faces"
        )
    return "".join(
        face.letter + face.digit + face.orientation for face in faces
    )


def rotate_faces(faces: Sequence[Face], clockwise_quarter_turns: int) -> tuple[Face, ...]:
    if clockwise_quarter_turns not in range(4):
        raise ValueError("rotation must be 0, 1, 2, or 3 clockwise quarter-turns")
    if len(faces) != 25:
        raise ProfileInputError(
            "INVALID_LENGTH", "a DiceKey must contain exactly 25 faces"
        )
    indexes = ROTATION_INDEXES[clockwise_quarter_turns]
    return tuple(
        Face(
            faces[index].letter,
            faces[index].digit,
            FACE_ORIENTATIONS[
                (FACE_ORIENTATIONS.index(faces[index].orientation)
                 + clockwise_quarter_turns) % 4
            ],
        )
        for index in indexes
    )


def all_four_rotations(human_readable_form: str) -> tuple[str, str, str, str]:
    faces = parse_dicekey_hrf(human_readable_form)
    return tuple(serialize_faces(rotate_faces(faces, turns)) for turns in range(4))


def canonicalize_dicekey(human_readable_form: str) -> str:
    """Return the bytewise lexicographically earliest physical rotation."""
    return min(all_four_rotations(human_readable_form))


def blake2b_256(*, key: bytes, message: bytes) -> bytes:
    """RFC 7693 keyed BLAKE2b with a 32-byte digest."""
    if len(key) != 32:
        raise ValueError("this profile requires a 32-byte BLAKE2b key")
    return hashlib.blake2b(message, key=key, digest_size=32).digest()


def derive_entropy(human_readable_form: str) -> tuple[str, bytes]:
    canonical_seed_string = canonicalize_dicekey(human_readable_form)
    input_key_material = canonical_seed_string.encode("ascii")
    pseudorandom_key = blake2b_256(key=bytes(32), message=input_key_material)
    entropy = blake2b_256(
        key=pseudorandom_key,
        message=DERIVATION_INFO + b"\x01",
    )
    return canonical_seed_string, entropy


def load_english_word_list() -> tuple[str, ...]:
    raw = WORD_LIST_PATH.read_bytes()
    actual_hash = hashlib.sha256(raw).hexdigest()
    if actual_hash != WORD_LIST_SHA256:
        raise RuntimeError(
            f"BIP39 English word-list hash mismatch: {actual_hash}"
        )
    try:
        words = tuple(raw.decode("ascii").splitlines())
    except UnicodeDecodeError as error:
        raise RuntimeError("BIP39 English word list must be ASCII") from error
    if (
        len(words) != 2048
        or len(set(words)) != 2048
        or words != tuple(sorted(words))
        or any(not word.islower() or not word.isalpha() for word in words)
    ):
        raise RuntimeError("BIP39 English word-list structure is invalid")
    return words


def entropy_to_bip39_mnemonic(
    entropy: bytes, word_list: Sequence[str] | None = None
) -> str:
    if len(entropy) != 32:
        raise ValueError("DK-BIP39-24-v1 requires exactly 32 entropy bytes")
    words = tuple(word_list) if word_list is not None else load_english_word_list()
    if len(words) != 2048:
        raise ValueError("BIP39 word list must contain exactly 2048 words")
    checksum = hashlib.sha256(entropy).digest()[:1]
    entropy_and_checksum = int.from_bytes(entropy + checksum, "big")
    indexes = tuple(
        (entropy_and_checksum >> ((23 - word_number) * 11)) & 0x7FF
        for word_number in range(24)
    )
    return " ".join(words[index] for index in indexes)


def derive_profile(human_readable_form: str) -> dict[str, str]:
    canonical_seed_string, entropy = derive_entropy(human_readable_form)
    return {
        "profile": PROFILE_ID,
        "canonicalSeedString": canonical_seed_string,
        "derivedEntropyHex": entropy.hex(),
        "mnemonic": entropy_to_bip39_mnemonic(entropy),
    }


def _expect_input_error(candidate: str, expected_code: str) -> None:
    try:
        derive_profile(candidate)
    except ProfileInputError as error:
        assert error.code == expected_code
        return
    raise AssertionError("malformed DiceKey input was accepted")


def run_self_test() -> int:
    """Run fixed algorithm and the complete committed conformance corpus."""
    assert hashlib.blake2b(b"abc", digest_size=64).hexdigest() == (
        "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d"
        "17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
    )
    assert blake2b_256(key=bytes(32), message=b"abc").hex() == (
        "bad705ff155af631f38dc6cafdda827a31595c802f3ff585c10691c58944d89b"
    )
    assert entropy_to_bip39_mnemonic(bytes(32)) == " ".join(
        ["abandon"] * 23 + ["art"]
    )

    vector_document = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    vectors = vector_document.get("vectors", [])
    expected_vector_count = vector_document["generation"]["validVectorCount"]
    expected_derivation_count = vector_document["generation"][
        "physicalRotationDerivationCount"
    ]
    assert vector_document["profile"] == PROFILE_ID
    assert vector_document["generation"]["recipeUtf8Hex"] == RECIPE_BYTES.hex()
    precedence_document = vector_document["invalidValidationPrecedence"]
    committed_precedence: list[str] = []
    for step in precedence_document["steps"]:
        if "errorCode" in step:
            committed_precedence.append(step["errorCode"])
        else:
            committed_precedence.extend(step["perFaceErrorOrder"])
    assert tuple(committed_precedence) == VALIDATION_ERROR_PRECEDENCE
    assert precedence_document["multipleFailureRule"] == (
        "stop at the first failed step or first failed per-face check"
    )
    if len(vectors) != expected_vector_count or len(vectors) < 5:
        raise AssertionError("committed valid-vector count does not match metadata")

    derivations_checked = 0
    for vector in vectors:
        rotations = all_four_rotations(vector["diceKeyHumanReadableForm"])
        assert list(rotations) == vector["allFourRotations"]
        assert min(rotations) == vector["canonicalSeedString"]
        assert vector["profile"] == PROFILE_ID
        assert vector["recipeUtf8Hex"] == RECIPE_BYTES.hex()
        for rotation in rotations:
            result = derive_profile(rotation)
            assert result["profile"] == PROFILE_ID
            assert result["canonicalSeedString"] == vector["canonicalSeedString"]
            assert result["derivedEntropyHex"] == vector["derivedEntropyHex"]
            assert result["mnemonic"] == vector["mnemonic"]
            derivations_checked += 1

    assert derivations_checked == expected_derivation_count
    invalid_cases = vector_document.get("invalidCases", [])
    if not invalid_cases:
        raise AssertionError("committed invalid cases are required")
    for invalid_case in invalid_cases:
        _expect_input_error(
            invalid_case["diceKeyHumanReadableForm"],
            invalid_case["expectedErrorCode"],
        )

    acquisition_cases = vector_document.get("acquisitionPolicyCases", [])
    if not acquisition_cases:
        raise AssertionError("committed acquisition-policy cases are required")
    for policy_case in acquisition_cases:
        assert policy_case["expectedAcquisitionState"] == "AMBIGUOUS_SCAN"
        assert policy_case["humanReadableFormProduced"] is False
        assert policy_case["profileDerivationInvoked"] is False
    return derivations_checked


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Derive DK-BIP39-24-v1 from one resolved 75-character DiceKey HRF"
    )
    parser.add_argument("human_readable_form", nargs="?")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="check fixed vectors, all rotations, BIP39, and invalid inputs",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        if args.human_readable_form is not None:
            parser.error("do not provide a DiceKey HRF with --self-test")
        checked = run_self_test()
        print(f"ok: {checked} committed rotation derivations matched")
        return 0
    if args.human_readable_form is None:
        parser.error("a 75-character DiceKey HRF is required")

    try:
        result = derive_profile(args.human_readable_form)
    except ProfileInputError as error:
        parser.exit(2, f"error: {error.code}: {error}\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
