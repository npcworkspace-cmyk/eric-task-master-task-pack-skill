from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock


TOOL = Path(__file__).resolve().parents[1] / "tools" / "skillkit.py"
SPEC = importlib.util.spec_from_file_location("skillkit", TOOL)
assert SPEC and SPEC.loader
skillkit = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = skillkit
SPEC.loader.exec_module(skillkit)


class RepoFixture:
    def __init__(self, base: Path, name: str = "example-social-skill", version: str = "1.2.3"):
        self.root = base
        self.name = name
        self.version = version
        self.skill = base / "skills" / name
        self.skill.mkdir(parents=True)
        (self.skill / "references").mkdir()
        (self.skill / "SKILL.md").write_text(
            "---\n"
            f"name: {name}\n"
            "description: Synthetic fixture Skill used by unit tests.\n"
            "metadata:\n"
            f"  version: \"{version}\"\n"
            "---\n\n"
            "# Synthetic Skill\n\n"
            "Read [the local contract](references/contract.md).\n",
            encoding="utf-8",
        )
        (self.skill / "references" / "contract.md").write_text(
            "# Synthetic contract\n\nNo real task values.\n", encoding="utf-8"
        )
        release = {
            "schema": 1,
            "name": name,
            "version": version,
            "platform": "example",
            "maturity": "alpha",
            "taskmaster_contract": "taskmaster-task-module-v1",
            "no_task_config": True,
            "no_credentials": True,
            "no_real_data": True,
        }
        (self.skill / "skill-release.json").write_text(
            json.dumps(release, indent=2) + "\n", encoding="utf-8"
        )
        (self.skill / "pack-manifest.json").write_text(
            '{"native_skill_manifest":true}\n', encoding="utf-8"
        )
        self.catalog = {
            "schema_version": 1,
            "project": "synthetic-skill-catalog",
            "version": "0.0.1",
            "repository": "https://example.com/synthetic/repository",
            "skills": [{
                "name": name,
                "path": f"skills/{name}",
                "version": version,
                "platform": "example",
                "maturity": "alpha",
                "taskmaster_contract": "taskmaster-task-module-v1",
                "tests": [["{python}", "-c", "print('synthetic test passed')"]],
            }],
        }
        self.catalog_path = base / "catalog.json"
        self.write_catalog()

    def write_catalog(self) -> None:
        self.catalog_path.write_text(json.dumps(self.catalog, indent=2) + "\n", encoding="utf-8")

    def entry(self):
        return skillkit.load_catalog(self.root)[1][0]


class SkillkitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skillkit-tests-")
        self.base = Path(self.temp.name)
        self.fixture = RepoFixture(self.base)

    def tearDown(self):
        self.temp.cleanup()

    def test_catalog_and_strict_validation(self):
        catalog, entries = skillkit.load_catalog(self.base)
        self.assertEqual(catalog["schema_version"], 1)
        result = skillkit.validate(self.base, entries, strict=True)
        self.assertTrue(result["passed"], result)
        self.assertEqual(entries[0].name, self.fixture.name)

    def test_catalog_supports_object_form_and_rejects_escape(self):
        self.fixture.catalog["skills"] = {
            self.fixture.name: {
                "path": f"skills/{self.fixture.name}",
                "version": self.fixture.version,
                "platform": "example",
                "maturity": "alpha",
                "taskmaster_contract": "taskmaster-task-module-v1",
                "tests": {"argv": ["{python}", "-c", "raise SystemExit(0)"]},
            }
        }
        self.fixture.write_catalog()
        entries = skillkit.load_catalog(self.base)[1]
        self.assertEqual(len(entries[0].tests), 1)
        self.fixture.catalog["skills"][self.fixture.name]["path"] = "../escape"
        self.fixture.write_catalog()
        with self.assertRaisesRegex(skillkit.SkillkitError, "escapes repository"):
            skillkit.load_catalog(self.base)

    def test_frontmatter_release_metadata_and_links_are_enforced(self):
        entry = self.fixture.entry()
        release_path = self.fixture.skill / "skill-release.json"
        release = json.loads(release_path.read_text(encoding="utf-8"))
        del release["no_real_data"]
        release_path.write_text(json.dumps(release), encoding="utf-8")
        skill_md = self.fixture.skill / "SKILL.md"
        skill_md.write_text(skill_md.read_text(encoding="utf-8").replace(
            "references/contract.md", "references/missing.md"), encoding="utf-8")
        result = skillkit.validate_skill(self.base, entry, strict=True)
        codes = {item["code"] for item in result["errors"]}
        self.assertIn("release_metadata", codes)
        self.assertIn("broken_link", codes)

        skill_md.write_text(skill_md.read_text(encoding="utf-8").replace(
            f'name: {self.fixture.name}', "name: wrong-name"), encoding="utf-8")
        result = skillkit.validate_skill(self.base, entry, strict=True)
        self.assertIn("frontmatter_name", {item["code"] for item in result["errors"]})

    def test_capability_object_taskmaster_contract_is_supported(self):
        contract = {
            "binding": "capability-based",
            "required_capabilities": ["page.goto", "writable-output-directory"],
            "optional_capabilities": ["wait-callback"],
            "version_pinned": False,
            "adapter_rule": "Synthetic fixture resolves the current local contract.",
        }
        release_path = self.fixture.skill / "skill-release.json"
        release = json.loads(release_path.read_text(encoding="utf-8"))
        release["taskmaster_contract"] = contract
        release_path.write_text(json.dumps(release), encoding="utf-8")
        self.fixture.catalog["skills"][0]["taskmaster_contract"] = contract
        self.fixture.write_catalog()
        result = skillkit.validate_skill(self.base, self.fixture.entry(), strict=True)
        self.assertTrue(result["passed"], result)

    def test_missing_frontmatter_version_always_fails(self):
        path = self.fixture.skill / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        text = text.replace("metadata:\n  version: \"1.2.3\"\n", "")
        path.write_text(text, encoding="utf-8")
        entry = self.fixture.entry()
        relaxed = skillkit.validate_skill(self.base, entry, strict=False)
        self.assertFalse(relaxed["passed"])
        self.assertIn("frontmatter_version", {item["code"] for item in relaxed["errors"]})
        strict = skillkit.validate_skill(self.base, entry, strict=True)
        self.assertFalse(strict["passed"])
        self.assertIn("frontmatter_version", {item["code"] for item in strict["errors"]})

    def test_cross_skill_absolute_and_missing_links_fail(self):
        outside = self.base / "skills" / "other.md"
        outside.write_text("other", encoding="utf-8")
        md = self.fixture.skill / "links.md"
        md.write_text(
            "[escape](../other.md)\n[absolute](/tmp/private.md)\n[missing](references/nope.md)\n"
            "[external](https://example.com/docs)\n",
            encoding="utf-8",
        )
        result = skillkit.validate_skill(self.base, self.fixture.entry(), strict=True)
        codes = {item["code"] for item in result["errors"]}
        self.assertTrue({"cross_skill_link", "absolute_link", "broken_link"}.issubset(codes))

    def test_links_in_code_fences_are_not_treated_as_files(self):
        md = self.fixture.skill / "example.md"
        md.write_text("```text\n[synthetic](missing.md)\n```\n", encoding="utf-8")
        result = skillkit.validate_skill(self.base, self.fixture.entry(), strict=True)
        self.assertTrue(result["passed"], result)

    def test_symlink_and_windows_reserved_name_are_rejected(self):
        reserved = self.fixture.skill / "CON.txt"
        try:
            reserved.write_text("reserved", encoding="utf-8")
        except OSError:
            reserved = None
        target = self.fixture.skill / "references" / "contract.md"
        link = self.fixture.skill / "linked.md"
        symlink_created = False
        try:
            link.symlink_to(target)
            symlink_created = True
        except (OSError, NotImplementedError):
            pass
        result = skillkit.validate_skill(self.base, self.fixture.entry(), strict=True)
        codes = {item["code"] for item in result["errors"]}
        if reserved is not None:
            self.assertIn("portable_filename", codes)
        if symlink_created:
            self.assertIn("symlink", codes)

    def test_leak_scanner_rejects_real_values_and_allows_explicit_synthetic_fixture(self):
        bad = "\n".join([
            r'data_dir = "C:\Users\alice\private\run"',
            r'escaped_dir = "C:\\Users\\alice\\private\\run"',
            r'network_dir = "\\server01\private-share\run"',
            r'escaped_network_dir = "\\\\server01\\private-share\\run"',
            'api_key = "liveCredentialMaterial123456"',
            'target = "https://www.facebook.com/groups/real-mothers-club"',
        ])
        codes = {item["code"] for item in skillkit.scan_text(bad, "scripts/config.py")}
        self.assertTrue({"windows_path", "assigned_secret", "facebook_target"}.issubset(codes))
        allowed = (
            r'synthetic fixture path = "C:\Users\example\test-only"' + "\n" +
            'api_key = "synthetic_test_only_credential"'
        )
        self.assertEqual(skillkit.scan_text(allowed, "tests/fixtures/synthetic.txt"), [])

    def test_unicode_casefold_and_windows_name_collisions_in_archive_names(self):
        infos = [
            zipfile.ZipInfo("skill/Café.txt"),
            zipfile.ZipInfo("skill/Cafe\u0301.txt"),
            zipfile.ZipInfo("skill/A/readme.md"),
            zipfile.ZipInfo("skill/a/other.md"),
            zipfile.ZipInfo("skill/NUL.json"),
        ]
        issues = skillkit._zip_name_issues(infos)
        joined = "\n".join(issues)
        self.assertIn("collision", joined)
        self.assertIn("reserved", joined)

    def test_catalog_test_argv_runs_without_shell_and_reports_failure(self):
        _, entries = skillkit.load_catalog(self.base)
        result = skillkit.run_tests(self.base, entries)
        self.assertTrue(result["passed"], result)
        self.assertIn("synthetic test passed", result["skills"][0]["commands"][0]["stdout"])

        self.fixture.catalog["skills"][0]["tests"] = [["{python}", "-c", "raise SystemExit(7)"]]
        self.fixture.write_catalog()
        result = skillkit.run_tests(self.base, skillkit.load_catalog(self.base)[1])
        self.assertFalse(result["passed"])
        self.assertEqual(result["skills"][0]["commands"][0]["exit_code"], 7)

    def test_package_is_deterministic_and_writes_release_metadata(self):
        catalog, entries = skillkit.load_catalog(self.base)
        out_a = self.base / "dist a"
        out_b = self.base / "dist 测试"
        first = skillkit.package(self.base, entries, out_a, catalog)
        second = skillkit.package(self.base, entries, out_b, catalog)
        archive_name = first["artifacts"][0]["archive"]
        archive_a = out_a / archive_name
        archive_b = out_b / archive_name
        self.assertEqual(archive_a.read_bytes(), archive_b.read_bytes())
        verified = skillkit.verify_archive(archive_a)
        self.assertEqual(verified["name"], self.fixture.name)
        self.assertEqual(verified["version"], self.fixture.version)
        with zipfile.ZipFile(archive_a, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("archive-manifest.json", names)
        self.assertIn(f"{self.fixture.name}/pack-manifest.json", names)
        self.assertTrue((out_a / "SHA256SUMS").read_text(encoding="utf-8").endswith(f"  {archive_name}\n"))
        index = json.loads((out_a / "release-index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["artifacts"][0]["sha256"], skillkit._sha256_file(archive_a))
        self.assertEqual(index["project"], "synthetic-skill-catalog")
        self.assertEqual(index["version"], "0.0.1")

    def _bad_zip(self, filename: str, members: list[tuple[zipfile.ZipInfo | str, bytes]]) -> Path:
        path = self.base / filename
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w") as archive:
                for name, data in members:
                    archive.writestr(name, data)
        return path

    def _backslash_zip(self) -> Path:
        path = self._bad_zip("backslash.zip", [("safe/file", b"x")])
        data = path.read_bytes().replace(b"safe/file", b"safe\\file")
        path.write_bytes(data)
        return path

    def test_verify_rejects_traversal_absolute_backslash_alias_duplicate_and_symlink(self):
        cases: list[tuple[str, list[tuple[zipfile.ZipInfo | str, bytes]], str]] = [
            ("traversal.zip", [("safe/../evil", b"x")], "non-canonical"),
            ("absolute.zip", [("/safe/file", b"x")], "absolute"),
            ("alias.zip", [("safe/./file", b"x")], "non-canonical"),
            ("duplicate.zip", [("safe/file", b"x"), ("safe/file", b"y")], "duplicate"),
            ("case.zip", [("safe/A.txt", b"x"), ("safe/a.txt", b"y")], "collision"),
        ]
        symlink = zipfile.ZipInfo("safe/link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases.append(("symlink.zip", [(symlink, b"target")], "symlink"))
        for filename, members, expected in cases:
            with self.subTest(filename=filename):
                path = self._bad_zip(filename, members)
                with self.assertRaisesRegex(skillkit.SkillkitError, expected):
                    skillkit.verify_archive(path)
        with self.assertRaisesRegex(skillkit.SkillkitError, "backslash"):
            skillkit.verify_archive(self._backslash_zip())

    def test_verify_rejects_manifest_tamper_and_content_leak(self):
        catalog, entries = skillkit.load_catalog(self.base)
        out = self.base / "dist"
        result = skillkit.package(self.base, entries, out, catalog)
        original = out / result["artifacts"][0]["archive"]
        tampered = self.base / "tampered.zip"
        with zipfile.ZipFile(original, "r") as source, zipfile.ZipFile(tampered, "w") as target:
            for info in source.infolist():
                data = source.read(info)
                if info.filename.endswith("SKILL.md"):
                    data += b"\nchanged\n"
                target.writestr(info, data)
        with self.assertRaisesRegex(skillkit.SkillkitError, "manifest hash"):
            skillkit.verify_archive(tampered)

        leaked = self.base / "leaked.zip"
        root = self.fixture.name
        files = {
            "SKILL.md": (self.fixture.skill / "SKILL.md").read_bytes(),
            "skill-release.json": (self.fixture.skill / "skill-release.json").read_bytes(),
            "secret.txt": b'api_key = "actualCredentialMaterial123456"\n',
        }
        manifest = {
            "schema_version": 1,
            "name": root,
            "version": self.fixture.version,
            "files": [{"path": key, "bytes": len(value), "sha256": skillkit._sha256(value)} for key, value in sorted(files.items())],
        }
        with zipfile.ZipFile(leaked, "w") as archive:
            for rel, data in files.items():
                archive.writestr(f"{root}/{rel}", data)
            archive.writestr("archive-manifest.json", skillkit._json_bytes(manifest))
        with self.assertRaisesRegex(skillkit.SkillkitError, "credential"):
            skillkit.verify_archive(leaked)

    def test_archive_envelope_is_unique_at_root_and_is_not_installed(self):
        catalog, entries = skillkit.load_catalog(self.base)
        out = self.base / "envelope dist"
        result = skillkit.package(self.base, entries, out, catalog)
        original = out / result["artifacts"][0]["archive"]

        missing = self.base / "missing-envelope.zip"
        unexpected = self.base / "unexpected-root.zip"
        duplicate = self.base / "duplicate-envelope.zip"
        with zipfile.ZipFile(original, "r") as source:
            source_items = [(info, source.read(info)) for info in source.infolist()]
        with zipfile.ZipFile(missing, "w") as target:
            for info, data in source_items:
                if info.filename != "archive-manifest.json":
                    target.writestr(info, data)
        with self.assertRaisesRegex(skillkit.SkillkitError, "exactly one root archive-manifest"):
            skillkit.verify_archive(missing)

        with zipfile.ZipFile(unexpected, "w") as target:
            for info, data in source_items:
                target.writestr(info, data)
            target.writestr("unexpected.txt", "root sidecar")
        with self.assertRaisesRegex(skillkit.SkillkitError, "unexpected root"):
            skillkit.verify_archive(unexpected)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(duplicate, "w") as target:
                for info, data in source_items:
                    target.writestr(info, data)
                envelope = next(data for info, data in source_items if info.filename == "archive-manifest.json")
                target.writestr("archive-manifest.json", envelope)
        with self.assertRaisesRegex(skillkit.SkillkitError, "duplicate archive member"):
            skillkit.verify_archive(duplicate)

        skills_dir = self.base / "envelope install"
        installed = skillkit.install_archive(original, skills_dir, replace=False)
        target = Path(installed["target"])
        self.assertFalse((target / "archive-manifest.json").exists())
        self.assertEqual((target / "pack-manifest.json").read_text(encoding="utf-8"), '{"native_skill_manifest":true}\n')

    def test_install_source_archive_precedence_and_replace_backup(self):
        catalog, entries = skillkit.load_catalog(self.base)
        explicit = self.base / "explicit skills"
        self.assertEqual(skillkit.resolve_skills_dir(explicit, {"SOCIAL_SKILLS_DIR": str(self.base / "env")}), explicit.resolve())
        self.assertEqual(
            skillkit.resolve_skills_dir(None, {"SOCIAL_SKILLS_DIR": str(self.base / "env"), "CODEX_HOME": str(self.base / "codex")}),
            (self.base / "env").resolve(),
        )
        self.assertEqual(
            skillkit.resolve_skills_dir(None, {"CODEX_HOME": str(self.base / "codex")}),
            (self.base / "codex" / "skills").resolve(),
        )
        self.assertEqual(skillkit.resolve_skills_dir(None, {}, self.base / "home"), (self.base / "home" / ".codex" / "skills").resolve())

        source_result = skillkit.install_source(self.base, entries[0], explicit, replace=False)
        target = Path(source_result["target"])
        self.assertEqual((target / "pack-manifest.json").read_text(encoding="utf-8"), '{"native_skill_manifest":true}\n')
        self.assertFalse((target / "archive-manifest.json").exists())
        with self.assertRaisesRegex(skillkit.SkillkitError, "already exists"):
            skillkit.install_source(self.base, entries[0], explicit, replace=False)
        (target / "old-only.txt").write_text("old", encoding="utf-8")
        replaced = skillkit.install_source(self.base, entries[0], explicit, replace=True)
        self.assertFalse((target / "old-only.txt").exists())
        self.assertTrue(Path(replaced["backup"]).joinpath("old-only.txt").is_file())

        out = self.base / "dist"
        packaged = skillkit.package(self.base, entries, out, catalog)
        archive = out / packaged["artifacts"][0]["archive"]
        archive_skills = self.base / "archive skills 测试"
        installed = skillkit.install_archive(archive, archive_skills, replace=False)
        self.assertTrue(Path(installed["target"]).joinpath("SKILL.md").is_file())
        self.assertFalse(Path(installed["target"]).joinpath("archive-manifest.json").exists())
        self.assertEqual(skillkit.verify_archive(archive)["sha256"], skillkit._sha256_file(archive))

    def test_failed_replace_rolls_back_original(self):
        parent = self.base / "install"
        parent.mkdir()
        target = parent / "example"
        target.mkdir()
        (target / "state.txt").write_text("original", encoding="utf-8")
        stage = parent / "stage"
        stage.mkdir()
        (stage / "state.txt").write_text("new", encoding="utf-8")
        real_replace = os.replace
        calls = 0

        def flaky_replace(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic promotion failure")
            return real_replace(source, destination)

        with mock.patch.object(skillkit.os, "replace", side_effect=flaky_replace):
            with self.assertRaisesRegex(OSError, "synthetic promotion failure"):
                skillkit._promote_stage(stage, target, replace=True)
        self.assertEqual((target / "state.txt").read_text(encoding="utf-8"), "original")

    def test_cli_validate_test_package_verify_and_install(self):
        dist = self.base / "cli dist"
        commands = [
            [sys.executable, str(TOOL), "--catalog", str(self.fixture.catalog_path), "validate", "--all", "--strict"],
            [sys.executable, str(TOOL), "--catalog", str(self.fixture.catalog_path), "test", "--all"],
            [sys.executable, str(TOOL), "--catalog", str(self.fixture.catalog_path), "package", "--all", "--output", str(dist)],
        ]
        for argv in commands:
            completed = subprocess.run(argv, cwd=self.base, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
            self.assertTrue(json.loads(completed.stdout)["passed"])
        archive = dist / f"{self.fixture.name}-v{self.fixture.version}.zip"
        skills_dir = self.base / "cli skills"
        for argv in (
            [sys.executable, str(TOOL), "verify", "--archive", str(archive)],
            [sys.executable, str(TOOL), "install", "--archive", str(archive), "--skills-dir", str(skills_dir)],
        ):
            completed = subprocess.run(argv, cwd=self.base, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
            self.assertTrue(json.loads(completed.stdout)["passed"])
        self.assertTrue((skills_dir / self.fixture.name / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
