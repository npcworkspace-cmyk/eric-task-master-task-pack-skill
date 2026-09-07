"""Exercise the real YouTube release with synthetic data and no browser/network."""

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
NAME = "youtube-creator-discovery"


def inventory(root: Path) -> dict:
    return {
        p.relative_to(root).as_posix(): {
            "bytes": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        }
        for p in sorted(root.rglob("*")) if p.is_file()
    }


class YouTubeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_parent = Path(tempfile.gettempdir()).resolve()
        self.temp = tempfile.TemporaryDirectory(prefix="yt-release-", dir=self.temp_parent)
        self.base = Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup_temp)
        self.assertFalse(self.base.is_relative_to(REPO))
        self.outside = self.base / "运行 outside repository"
        self.outside.mkdir()
        self.env = os.environ.copy()
        self.env["PYTHONUTF8"] = "1"
        self.env.pop("NODE_PATH", None)
        self.env.pop("NODE_OPTIONS", None)

    def cleanup_temp(self):
        self.assertEqual(self.base, Path(self.temp.name).resolve())
        self.assertEqual(self.base.parent, self.temp_parent)
        self.assertTrue(self.base.name.startswith("yt-release-"))
        self.temp.cleanup()

    def run_command(self, argv: list[str]) -> str:
        result = subprocess.run(
            argv, cwd=self.outside, env=self.env, capture_output=True,
            text=True, encoding="utf-8", shell=False, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    def skillkit(self, *args: str) -> dict:
        result = json.loads(self.run_command([sys.executable, "-B", str(TOOL), *args]))
        self.assertTrue(result["passed"], result)
        return result

    def test_catalog_archive_installs_and_runs_independently(self):
        catalog = json.loads((REPO / "catalog.json").read_text(encoding="utf-8"))
        entries = [e for e in catalog["skills"] if e["name"] == NAME]
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        source = (REPO / entry["path"]).resolve()
        source_files = inventory(source)
        metadata = json.loads((source / "skill-release.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["name"], NAME)
        self.assertEqual(metadata["version"], entry["version"])
        archives = []
        for label in ("dist first", "dist second"):
            output = self.base / label
            packaged = self.skillkit("--catalog", str(REPO / "catalog.json"),
                                    "package", "--skill", NAME, "--output", str(output))
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
        self.assertEqual(manifest["name"], NAME)
        self.assertEqual(manifest["version"], metadata["version"])
        self.assertEqual({r["path"]: {"bytes": r["bytes"], "sha256": r["sha256"]}
                          for r in manifest["files"]}, source_files)
        self.assertEqual(verified["files"], len(source_files))
        installed = self.skillkit("install", "--archive", str(archives[0]),
                                 "--skills-dir", str(self.base / "安装 skills with spaces"))
        target = Path(installed["target"]).resolve()
        self.assertTrue(target.is_relative_to(self.base))
        self.assertEqual(inventory(target), source_files)
        self.assertFalse((target / "archive-manifest.json").exists())

        node = shutil.which("node")
        self.assertIsNotNone(node)
        run_dir = self.outside / "synthetic run"
        (run_dir / "evidence").mkdir(parents=True)
        (run_dir / "project.json").write_text(
            json.dumps({"targetCount": 1, "baselineIds": []}), encoding="utf-8")
        output_dir = self.outside / "processed output"
        config = self.outside / "process.json"
        config.write_text(json.dumps({"runDir": str(run_dir), "outputDir": str(output_dir)}),
                          encoding="utf-8")
        result = json.loads(self.run_command([node, str(target / "scripts/process.mjs"), str(config)]))
        self.assertEqual(result["processorVersion"], metadata["components"]["processor"])
        self.assertEqual(result["formal"], 0)
        self.assertFalse(result["review"]["allFormalReviewed"])
        self.assertIsNone(result["review"]["overallEstimatedHitRate"])
        self.assertTrue((output_dir / "identity-queue.json").is_file())
        for state in ("qualified", "pending", "rejected", "unreviewed"):
            self.assertTrue((output_dir / (state + ".csv")).is_file())

        tap = self.run_command([node, "--test", "--test-reporter=tap",
                                str(target / "scripts/behavior.test.mjs")])
        counts = {name: int(count) for name, count in re.findall(
            r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$", tap, re.MULTILINE)}
        self.assertGreaterEqual(counts.get("tests", 0), 14, tap)
        self.assertEqual(counts.get("pass"), counts["tests"], tap)
        for status in ("fail", "cancelled", "skipped", "todo"):
            self.assertEqual(counts.get(status), 0, tap)
        self.assertEqual(inventory(target), source_files)
        self.assertEqual(inventory(source), source_files)
        print(f"Verified {NAME} v{metadata['version']}: identical ZIPs, {len(source_files)} "
              f"installed files, real CLI and {counts['tests']} installed offline tests.")


if __name__ == "__main__":
    unittest.main()
