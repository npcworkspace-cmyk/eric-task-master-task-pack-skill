"""Synthetic audit-evidence tests; no browser, credentials or platform data."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SKILL = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audit_snapshot", SKILL / "scripts" / "snapshot.py")
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "合成 包"
        self.root.mkdir()
        (self.root / "SKILL.md").write_text("Synthetic audit fixture\n", encoding="utf-8")
        self.record = self.base / "snapshot.json"

    def tearDown(self):
        self.temp.cleanup()

    def test_relocation_preserves_identity_and_does_not_claim_audit_pass(self):
        snapshot.create(self.root, self.record)
        relocated = self.base / "另一 环境"
        shutil.copytree(self.root, relocated)
        result = snapshot.verify(relocated, self.record)
        self.assertEqual(result["status"], "files_match")
        self.assertEqual(result["semantic_audit"], "not_performed")
        record = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(record["files"][0]["path"], "SKILL.md")
        self.assertNotIn(str(self.base), self.record.read_text(encoding="utf-8"))

    def test_edits_additions_and_deletions_invalidate_old_review(self):
        snapshot.create(self.root, self.record)
        original = (self.root / "SKILL.md").read_bytes()
        (self.root / "SKILL.md").write_bytes(b"Synthetic changed fixture\n")
        with self.assertRaisesRegex(ValueError, "differs"):
            snapshot.verify(self.root, self.record)
        (self.root / "SKILL.md").write_bytes(original)
        extra = self.root / "new.mjs"
        extra.write_text("// Synthetic new fixture\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "differs"):
            snapshot.verify(self.root, self.record)
        extra.unlink()
        (self.root / "SKILL.md").unlink()
        with self.assertRaisesRegex(ValueError, "empty"):
            snapshot.verify(self.root, self.record)

    def test_does_not_overwrite_prior_evidence_or_write_into_target(self):
        snapshot.create(self.root, self.record)
        original = self.record.read_bytes()
        with self.assertRaises(FileExistsError):
            snapshot.create(self.root, self.record)
        self.assertEqual(self.record.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, "outside"):
            snapshot.create(self.root, self.root / "snapshot.json")
        self.assertEqual(len(list(self.root.iterdir())), 1)

    def test_bundle_members_are_included_without_a_fixed_layout(self):
        member = self.root / "shared" / "stage-two" / "runtime.py"
        member.parent.mkdir(parents=True)
        member.write_text("# Synthetic shared runtime\n", encoding="utf-8")
        snapshot.create(self.root, self.record)
        member.write_text("# Synthetic changed runtime\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "differs"):
            snapshot.verify(self.root, self.record)

    def test_link_or_reparse_point_is_rejected_without_reading_target(self):
        original = snapshot.is_link
        with patch.object(snapshot, "is_link", side_effect=lambda path: path.name == "SKILL.md" or original(path)):
            with self.assertRaisesRegex(ValueError, "Links"):
                snapshot.inventory(self.root)
        with patch.object(snapshot, "is_link", return_value=True):
            with self.assertRaisesRegex(ValueError, "ordinary"):
                snapshot.inventory(self.root)

    def test_unreadable_walk_is_not_silently_accepted(self):
        def denied_walk(root, followlinks, onerror):
            onerror(PermissionError("Synthetic fixture denied"))
            return iter(())
        with patch.object(snapshot.os, "walk", side_effect=denied_walk):
            with self.assertRaises(PermissionError):
                snapshot.inventory(self.root)

    def test_standalone_cli_installs_without_repository_or_browser(self):
        installed = self.base / "安装 skills" / "task-pack-audit"
        shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns("__pycache__"))
        isolated = self.base / "isolated"
        isolated.mkdir()
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        script = installed / "scripts" / "snapshot.py"
        for action in ("create", "verify"):
            result = subprocess.run([sys.executable, "-I", str(script), action, str(installed),
                                     "--snapshot", str(self.record)], cwd=isolated, env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["semantic_audit"], "not_performed")
        (installed / "SKILL.md").write_text("Synthetic stale audit\n", encoding="utf-8")
        result = subprocess.run([sys.executable, "-I", str(script), "verify", str(installed),
                                 "--snapshot", str(self.record)], cwd=isolated,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
