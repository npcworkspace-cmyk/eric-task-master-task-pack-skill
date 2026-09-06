"""Synthetic release-integrity fixtures; no platform or installed-user data."""
import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import tiktok_bundle as bundle

class BundleTests(unittest.TestCase):
    def fixture(self, root):
        release = root / "release"
        records = []
        for name in bundle.MEMBERS:
            rel = "skills/" + name + "/SKILL.md"
            file = release / rel
            file.parent.mkdir(parents=True)
            data = b"# Synthetic release fixture\n"
            file.write_bytes(data)
            records.append({"path": rel, "bytes": len(data), "sha256": bundle.digest(data)})
        bundle.write_json(release / "manifest.json", {"packageVersion": "2.1.1", "files": records})
        return release

    def test_archive_is_deterministic_and_hash_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.fixture(root)
            first, second = root / "first.zip", root / "second.zip"
            bundle.write_archive(release, first)
            bundle.write_archive(release, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(bundle.verify_native_archive(first), {"version": "2.1.1", "files": 4})

    def test_corrupt_member_or_traversal_is_rejected_before_extract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.fixture(root)
            original = root / "original.zip"
            bundle.write_archive(release, original)
            for bad_name, bad_data, pattern in [
                ("skills/" + bundle.MEMBERS[0] + "/SKILL.md", b"changed", "hash mismatch"),
                ("../../outside", b"payload", "traversal|unsafe|non-canonical"),
            ]:
                bad = root / ("bad-" + str(len(bad_data)) + ".zip")
                with zipfile.ZipFile(original) as src, zipfile.ZipFile(bad, "w") as dst:
                    for info in src.infolist():
                        dst.writestr(info, bad_data if info.filename == bad_name else src.read(info))
                    if bad_name.startswith(".."):
                        dst.writestr(bad_name, bad_data)
                with self.assertRaisesRegex(bundle.skillkit.SkillkitError, pattern):
                    bundle.verify_native_archive(bad)

    def test_bundle_index_preserves_existing_platform_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.fixture(root)
            dist = root / "dist"
            dist.mkdir()
            other = {"name": "example-other-skill", "archive": "other.zip", "sha256": "0" * 64, "version": "1.0.0"}
            bundle.write_json(dist / "release-index.json", {"artifacts": [other]})
            entry = {"name": "tiktok-discovery", "version": "2.1.1", "maturity": "portable-offline-validated"}
            with patch.object(bundle, "build_native", return_value=(entry, {"offlineTests": {"tests": 1}}, release)):
                result = bundle.package(dist)
            index = bundle.read_json(dist / "release-index.json")
            self.assertEqual(index["artifacts"][0], other)
            asset = result["artifact"]
            self.assertEqual(asset["members"], bundle.MEMBERS)
            self.assertEqual(asset["sha256"], bundle.digest((dist / asset["archive"]).read_bytes()))
            sums = (dist / "SHA256SUMS").read_text()
            self.assertIn(other["sha256"] + "  other.zip\n", sums)
            self.assertIn(asset["sha256"] + "  " + asset["archive"] + "\n", sums)

if __name__ == "__main__":
    unittest.main()
