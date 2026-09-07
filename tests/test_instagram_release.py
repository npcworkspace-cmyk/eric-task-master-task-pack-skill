"""Exercise the real Instagram catalog release without a browser or network."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
TOOL = REPO / "tools" / "skillkit.py"
NAME = "instagram-creator-discovery"


def inventory(root: Path) -> dict[str, dict[str, int | str]]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            data = path.read_bytes()
            result[path.relative_to(root).as_posix()] = {
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()
            }
    return result


class InstagramReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_parent = Path(tempfile.gettempdir()).resolve()
        self.temp = tempfile.TemporaryDirectory(prefix="ig-release-", dir=self.temp_parent)
        self.base = Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup_temp)
        self.assertFalse(self.base.is_relative_to(REPO))
        self.outside = self.base / "运行 outside repository"
        self.outside.mkdir()
        scratch = self.base / "node scratch"
        scratch.mkdir()
        self.env = os.environ.copy()
        self.env.update(PYTHONUTF8="1", TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch))
        self.env.pop("NODE_PATH", None)
        self.env.pop("NODE_OPTIONS", None)

    def cleanup_temp(self):
        # Only remove the exact temporary root allocated for this test.
        self.assertEqual(self.base, Path(self.temp.name).resolve())
        self.assertEqual(self.base.parent, self.temp_parent)
        self.assertTrue(self.base.name.startswith("ig-release-"))
        self.temp.cleanup()

    def run_command(self, argv: list[str]) -> str:
        completed = subprocess.run(
            argv, cwd=self.outside, env=self.env, capture_output=True,
            text=True, encoding="utf-8", shell=False, timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        return completed.stdout

    def skillkit(self, *args: str) -> dict:
        result = json.loads(self.run_command([sys.executable, "-B", str(TOOL), *args]))
        self.assertTrue(result["passed"], result)
        return result

    def test_catalog_archive_installs_and_runs_independently(self):
        catalog = json.loads((REPO / "catalog.json").read_text(encoding="utf-8"))
        entries = [entry for entry in catalog["skills"] if entry["name"] == NAME]
        self.assertEqual(len(entries), 1, "Instagram must be registered in the real catalog")
        entry = entries[0]
        source = (REPO / entry["path"]).resolve()
        self.assertTrue(source.is_relative_to(REPO))
        source_files = inventory(source)
        metadata = json.loads((source / "skill-release.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["name"], NAME)
        self.assertEqual(metadata["version"], entry["version"])

        archives = []
        for label in ("dist first", "dist second"):
            output = self.base / label
            packaged = self.skillkit(
                "--catalog", str(REPO / "catalog.json"), "package", "--skill", NAME,
                "--output", str(output),
            )
            self.assertEqual(len(packaged["artifacts"]), 1)
            artifact = packaged["artifacts"][0]
            self.assertEqual(artifact["version"], metadata["version"])
            archive = output / artifact["archive"]
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), artifact["sha256"])
            archives.append(archive)
        self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())

        verified = self.skillkit("verify", "--archive", str(archives[0]))
        with zipfile.ZipFile(archives[0]) as archive:
            manifest = json.loads(archive.read("archive-manifest.json"))
        manifest_files = {
            record["path"]: {"bytes": record["bytes"], "sha256": record["sha256"]}
            for record in manifest["files"]
        }
        self.assertEqual(manifest["name"], NAME)
        self.assertEqual(manifest["version"], metadata["version"])
        self.assertEqual(manifest_files, source_files)
        self.assertEqual(verified["files"], len(manifest_files))

        skills_dir = self.base / "安装 skills with spaces"
        installed = self.skillkit(
            "install", "--archive", str(archives[0]), "--skills-dir", str(skills_dir),
        )
        target = Path(installed["target"]).resolve()
        self.assertEqual(target, (skills_dir / NAME).resolve())
        self.assertTrue(target.is_relative_to(self.base))
        self.assertEqual(inventory(target), source_files)
        self.assertFalse((target / "archive-manifest.json").exists())

        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to test the installed release")
        help_text = self.run_command([node, str(target / "scripts" / "ig-audit.mjs"), "--help"])
        self.assertIn("--accounts", help_text)
        self.assertIn("--target", help_text)
        self.assertIn("--out", help_text)

        tests = sorted(path for path in target.rglob("*.test.mjs") if path.is_file())
        self.assertTrue(tests, "The archive must include its offline behavior tests")
        tap = self.run_command([node, "--test", "--test-reporter=tap", *map(str, tests)])
        counts = {name: int(count) for name, count in re.findall(
            r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$", tap, re.MULTILINE,
        )}
        self.assertGreaterEqual(counts.get("tests", 0), 49, tap)
        self.assertEqual(counts.get("pass"), counts["tests"], tap)
        for status in ("fail", "cancelled", "skipped", "todo"):
            self.assertEqual(counts.get(status), 0, tap)
        self.assertEqual(inventory(target), source_files, "Installed tests must not alter the payload")
        self.assertEqual(inventory(source), source_files, "Integration test must not alter repository source")
        print(
            f"Verified {NAME} v{metadata['version']}: two identical ZIPs, "
            f"{len(manifest_files)} installed files, CLI help, "
            f"{counts['tests']} installed offline tests passed outside the repository."
        )


if __name__ == "__main__":
    unittest.main()
