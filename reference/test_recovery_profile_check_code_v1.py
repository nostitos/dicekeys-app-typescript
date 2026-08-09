#!/usr/bin/env python3
"""Cross-runtime tests for the independent Phase 4 check-code references."""

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

import recovery_profile_check_code_v1 as python_reference  # noqa: E402


TYPESCRIPT_REFERENCE = REFERENCE_DIR / "recovery_profile_check_code_v1.ts"
SOURCE_VECTORS_PATH = REPOSITORY_DIR / "spec" / "test-vectors.json"
CHECK_CODE_VECTORS_PATH = (
    REPOSITORY_DIR / "spec" / "recovery-profile-check-code-v1-test-vectors.json"
)


class RecoveryProfileCheckCodeReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if cls.node is None:
            raise unittest.SkipTest("Node.js is not installed")
        cls.source = json.loads(SOURCE_VECTORS_PATH.read_text(encoding="utf-8"))
        cls.expected = json.loads(CHECK_CODE_VECTORS_PATH.read_text(encoding="utf-8"))

    def run_typescript(self, argument: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.node, str(TYPESCRIPT_REFERENCE), argument],
            cwd=REPOSITORY_DIR,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_python_self_test_covers_all_vectors_and_rotations(self) -> None:
        self.assertEqual(python_reference.run_self_test(), (27, 108))

    def test_typescript_self_test_covers_all_vectors_and_rotations(self) -> None:
        completed = self.run_typescript("--self-test")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            completed.stdout,
            "ok: 27 check-code vectors and 108 rotation associations matched\n",
        )

    def test_python_typescript_and_frozen_artifact_match_exactly(self) -> None:
        python_results = python_reference.all_vector_results()
        completed = self.run_typescript("--all-json")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        typescript_results = json.loads(completed.stdout)
        self.assertEqual(python_results, typescript_results)
        self.assertEqual(python_results, self.expected["vectors"])
        self.assertEqual(list(python_results), self.source["validVectorIdsInOrder"])

    def test_exact_prefix_and_fixed_v01_result(self) -> None:
        self.assertEqual(
            python_reference.PREFIX.hex(),
            "446963654b6579732f5265636f7665727950726f66696c65436865636b436f64652f763100444b2d42495033392d32342d763100",
        )
        self.assertEqual(
            python_reference.all_vector_results()["V01"],
            {
                "fullDigestHex": "521cbb8cfd07d4e44f94d70c2af68d2606bab17317de71553100af1488cde7cd",
                "checkCodeHex": "521CBB8CFD07",
                "displayCheckCode": "521C-BB8C-FD07",
            },
        )

    def test_strict_input_rejects_whitespace_case_unknown_words_and_bad_checksum(self) -> None:
        mnemonic = self.source["vectors"][0]["mnemonic"]
        candidates = [
            " " + mnemonic,
            mnemonic + " ",
            mnemonic.replace(" ", "  ", 1),
            mnemonic.replace(" ", "\t", 1),
            mnemonic.replace(" ", "\n", 1),
            mnemonic.replace(" ", "\u00a0", 1),
            mnemonic.replace("execute", "Execute", 1),
            mnemonic.replace("execute", "notaword", 1),
            mnemonic.rsplit(" ", 1)[0] + " abandon",
        ]
        for candidate in candidates:
            with self.subTest(candidate_kind=repr(candidate[:24])):
                with self.assertRaises(python_reference.CheckCodeInputError):
                    python_reference.derive_check_code(candidate)


if __name__ == "__main__":
    unittest.main()
