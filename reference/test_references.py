#!/usr/bin/env python3
"""Cross-implementation tests for the standalone profile references."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


REFERENCE_DIR = Path(__file__).resolve().parent
REPOSITORY_DIR = REFERENCE_DIR.parent
sys.path.insert(0, str(REFERENCE_DIR))

import dk_bip39_24_v1 as python_reference  # noqa: E402


TYPESCRIPT_REFERENCE = REFERENCE_DIR / "dk_bip39_24_v1.ts"
VECTORS_PATH = REPOSITORY_DIR / "spec" / "test-vectors.json"


class ReferenceParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if cls.node is None:
            raise unittest.SkipTest("Node.js is not installed")
        cls.document = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
        cls.vectors = cls.document["vectors"]
        cls.invalid_cases = cls.document["invalidCases"]
        cls.expected_derivation_count = cls.document["generation"][
            "physicalRotationDerivationCount"
        ]
        if len(cls.vectors) != cls.document["generation"]["validVectorCount"]:
            raise AssertionError("committed vector count does not match metadata")

    def run_typescript(self, argument: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.node, str(TYPESCRIPT_REFERENCE), argument],
            cwd=REPOSITORY_DIR,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_python_self_test(self) -> None:
        self.assertEqual(
            python_reference.run_self_test(), self.expected_derivation_count
        )

    def test_typescript_self_test(self) -> None:
        completed = self.run_typescript("--self-test")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            f"{self.expected_derivation_count} committed rotation derivations matched",
            completed.stdout,
        )

    def test_every_committed_rotation_derivation_matches(self) -> None:
        checked = 0
        for vector in self.vectors:
            for rotation in vector["allFourRotations"]:
                expected = python_reference.derive_profile(rotation)
                self.assertEqual(
                    set(expected),
                    {
                        "profile",
                        "canonicalSeedString",
                        "derivedEntropyHex",
                        "mnemonic",
                    },
                )
                completed = self.run_typescript(rotation)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout), expected)
                self.assertEqual(expected["canonicalSeedString"], vector["canonicalSeedString"])
                self.assertEqual(expected["derivedEntropyHex"], vector["derivedEntropyHex"])
                self.assertEqual(expected["mnemonic"], vector["mnemonic"])
                checked += 1
        self.assertEqual(checked, self.expected_derivation_count)

    def test_every_committed_invalid_case_fails_closed(self) -> None:
        for invalid_case in self.invalid_cases:
            candidate = invalid_case["diceKeyHumanReadableForm"]
            expected_code = invalid_case["expectedErrorCode"]
            with self.subTest(case_id=invalid_case["id"], expected_code=expected_code):
                with self.assertRaises(python_reference.ProfileInputError) as raised:
                    python_reference.derive_profile(candidate)
                self.assertEqual(raised.exception.code, expected_code)
                completed = self.run_typescript(candidate)
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(completed.stdout, "")
                self.assertTrue(
                    completed.stderr.startswith(f"error: {expected_code}:"),
                    completed.stderr,
                )

    def test_scanner_ambiguity_remains_outside_profile_core(self) -> None:
        policy_cases = self.document["acquisitionPolicyCases"]
        self.assertTrue(policy_cases)
        for policy_case in policy_cases:
            with self.subTest(case_id=policy_case["id"]):
                self.assertEqual(
                    policy_case["expectedAcquisitionState"], "AMBIGUOUS_SCAN"
                )
                self.assertIs(policy_case["humanReadableFormProduced"], False)
                self.assertIs(policy_case["profileDerivationInvoked"], False)


if __name__ == "__main__":
    unittest.main()
