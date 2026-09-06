#!/usr/bin/env python3
"""Validate, test, package, verify, and install independent Codex Skills.

The implementation deliberately uses only the Python standard library.  A
release archive contains exactly one Skill directory and is safe to install
without any sibling Skill or repository checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


CATALOG_NAME = "catalog.json"
ARCHIVE_MANIFEST_NAME = "archive-manifest.json"
RELEASE_METADATA_NAME = "skill-release.json"
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


class SkillkitError(RuntimeError):
    """A user-facing validation or release error."""


@dataclass(frozen=True)
class SkillEntry:
    name: str
    path: str
    version: str | None
    platform: str | None
    maturity: str | None
    taskmaster_contract: Any
    tests: tuple[Any, ...]
    raw: dict[str, Any]


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _within(path: Path, parent: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def _is_link_or_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attrs = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attrs & reparse)


def _safe_scalar(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if value[0:1] == value[-1:] and value[0] in {"'", '"'}:
        if value[0] == '"':
            try:
                return str(json.loads(value))
            except json.JSONDecodeError:
                pass
        return value[1:-1]
    return value.split(" #", 1)[0].strip()


def parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillkitError("SKILL.md is missing YAML frontmatter")
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration as exc:
        raise SkillkitError("SKILL.md frontmatter is not closed") from exc
    result: dict[str, str] = {}
    section: str | None = None
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        match = re.match(r"^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        if not match:
            continue
        key, raw_value = match.groups()
        if indent == 0:
            section = key if not raw_value.strip() else None
            if raw_value.strip():
                result[key] = _safe_scalar(raw_value)
        elif section == "metadata" and key == "version":
            result.setdefault("version", _safe_scalar(raw_value))
    return result


def load_catalog(repo_root: Path, catalog_path: Path | None = None) -> tuple[dict[str, Any], list[SkillEntry]]:
    repo_root = repo_root.resolve()
    path = (catalog_path or repo_root / CATALOG_NAME).resolve()
    if not path.is_file():
        raise SkillkitError(f"catalog not found: {path}")
    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SkillkitError(f"invalid catalog: {path}: {exc}") from exc
    raw_skills = catalog.get("skills")
    if isinstance(raw_skills, dict):
        raw_skills = [dict(value, name=key) for key, value in raw_skills.items()]
    if not isinstance(raw_skills, list) or not raw_skills:
        raise SkillkitError("catalog.skills must be a non-empty list or object")
    entries: list[SkillEntry] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_skills):
        if not isinstance(raw, dict):
            raise SkillkitError(f"catalog.skills[{index}] must be an object")
        name = raw.get("name")
        if not isinstance(name, str) or not SKILL_NAME_RE.fullmatch(name):
            raise SkillkitError(f"catalog.skills[{index}].name is invalid")
        if name in seen:
            raise SkillkitError(f"duplicate catalog Skill: {name}")
        seen.add(name)
        rel_path = raw.get("path", f"skills/{name}")
        if not isinstance(rel_path, str) or not rel_path:
            raise SkillkitError(f"catalog path is invalid for {name}")
        candidate = (repo_root / rel_path).resolve(strict=False)
        if not _within(candidate, repo_root):
            raise SkillkitError(f"catalog path escapes repository for {name}: {rel_path}")
        raw_tests = raw.get("tests", raw.get("test", raw.get("test_argv", ())))
        if isinstance(raw_tests, dict) and "argv" in raw_tests:
            raw_tests = [raw_tests]
        elif isinstance(raw_tests, list) and raw_tests and all(isinstance(item, str) for item in raw_tests):
            raw_tests = [raw_tests]
        if raw_tests is None:
            raw_tests = []
        if not isinstance(raw_tests, list):
            raise SkillkitError(f"catalog tests must be argv arrays for {name}")
        entries.append(SkillEntry(
            name=name,
            path=rel_path,
            version=str(raw["version"]) if raw.get("version") is not None else None,
            platform=str(raw["platform"]) if raw.get("platform") is not None else None,
            maturity=str(raw["maturity"]) if raw.get("maturity") is not None else None,
            taskmaster_contract=raw.get("taskmaster_contract"),
            tests=tuple(raw_tests),
            raw=raw,
        ))
    return catalog, entries


def select_entries(entries: Sequence[SkillEntry], skill: str | None, all_skills: bool) -> list[SkillEntry]:
    if all_skills == bool(skill):
        raise SkillkitError("choose exactly one of --all or --skill")
    if all_skills:
        return list(entries)
    selected = [entry for entry in entries if entry.name == skill]
    if not selected:
        raise SkillkitError(f"Skill is not in catalog: {skill}")
    return selected


def _portable_name_error(name: str) -> str | None:
    if not name or name in {".", ".."}:
        return "empty or dot path component"
    if name.endswith((" ", ".")):
        return "filename ends with a space or dot"
    if any(ord(char) < 32 or char in '<>:"/\\|?*' for char in name):
        return "filename contains a Windows-incompatible character"
    if name.split(".", 1)[0].upper() in WINDOWS_RESERVED:
        return "filename uses a Windows reserved device name"
    return None


def _tree_files(root: Path) -> tuple[list[Path], list[dict[str, str]]]:
    files: list[Path] = []
    issues: list[dict[str, str]] = []
    canonical: dict[tuple[str, ...], tuple[str, ...]] = {}
    if not root.is_dir():
        return files, [{"code": "skill_missing", "message": f"Skill directory not found: {root}"}]
    if _is_link_or_reparse(root):
        return files, [{"code": "symlink", "message": f"Skill root is a link or reparse point: {root}"}]
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        names = list(dirnames) + list(filenames)
        for name in names:
            item = current_path / name
            rel = item.relative_to(root)
            if _is_link_or_reparse(item):
                issues.append({"code": "symlink", "message": f"link or reparse point is forbidden: {rel.as_posix()}"})
                if name in dirnames:
                    dirnames.remove(name)
                continue
            name_error = _portable_name_error(name)
            if name_error:
                issues.append({"code": "portable_filename", "message": f"{rel.as_posix()}: {name_error}"})
            raw_parts = tuple(rel.parts)
            key = tuple(unicodedata.normalize("NFC", part).casefold() for part in raw_parts)
            previous = canonical.get(key)
            if previous is not None and previous != raw_parts:
                issues.append({"code": "filename_collision", "message": f"portable path collision: {'/'.join(previous)} <> {rel.as_posix()}"})
            else:
                canonical[key] = raw_parts
        for filename in filenames:
            item = current_path / filename
            if not _is_link_or_reparse(item) and item.is_file():
                files.append(item)
    return sorted(files, key=lambda item: item.relative_to(root).as_posix()), issues


def _allow_synthetic(logical_path: str, line: str) -> bool:
    logical = PurePosixPath(logical_path)
    path_parts = {part.casefold() for part in logical.parts}
    filename = logical.name.casefold()
    is_fixture = bool(path_parts & {"test", "tests", "fixture", "fixtures", "examples"}) or (
        filename.startswith(("test-", "test_")) or ".test." in filename or ".fixture." in filename
    )
    marker = re.search(r"(?i)synthetic|fixture|example|placeholder|replace[_ -]?with|fake|dummy|test-only", line)
    placeholder = "${" in line or "<" in line and ">" in line or "EXAMPLE_" in line or "REPLACE_" in line
    generic_test_path = is_fixture and re.search(
        r"(?i)(?:[A-Z]:[\\/](?:Agents(?:[ \\/]|$)|Users[\\/](?:old|new|current|example|test)(?:[\\/]|$)"
        r"|(?:Current|Old|New|Example|Test|Temp)(?:[\\/]|$)))"
        r"|/(?:home|Users)/(?:old|new|current|example|test)(?:/|$)"
        r"|/tmp/(?:old|new|current|example|test)(?:/|$)",
        line,
    )
    return bool(placeholder or (is_fixture and marker) or generic_test_path)


LEAK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("github_token", re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{12,}\b")),
    ("bearer_token", re.compile(r"(?i)\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}")),
    ("assigned_secret", re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|cookie)\b\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}")),
    ("windows_path", re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:[A-Z]:[\\/]{1,2})"
        r"(?:[^\\/\s'\"`<>|]{2,})(?:(?:[\\/]{1,2})[^\\/\s'\"`<>|]+)*"
    )),
    ("unc_path", re.compile(
        r"(?<![\\])\\\\[A-Za-z0-9][A-Za-z0-9._-]{1,}\\[A-Za-z0-9][A-Za-z0-9$._ -]{1,}"
        r"|(?<![\\])\\\\\\\\[A-Za-z0-9][A-Za-z0-9._-]{1,}\\\\[A-Za-z0-9][A-Za-z0-9$._ -]{1,}"
    )),
    ("posix_device_path", re.compile(r"(?<![A-Za-z0-9_.-])/(?:Users|home|root|mnt|Volumes)/(?:[^\s'\"`<>|]+)")),
    ("facebook_target", re.compile(r"(?i)https?://(?:www\.)?facebook\.com/groups/[A-Za-z0-9._-]{4,}")),
    ("instagram_target", re.compile(r"(?i)https?://(?:www\.)?instagram\.com/[A-Za-z0-9._]{3,}")),
    ("tiktok_target", re.compile(r"(?i)https?://(?:www\.)?tiktok\.com/@[A-Za-z0-9._-]{3,}")),
    ("reddit_target", re.compile(r"(?i)https?://(?:www\.)?reddit\.com/r/[^/\s]+/comments/[A-Za-z0-9]{4,}")),
)


def scan_text(text: str, logical_path: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for number, line in enumerate(text.splitlines(), 1):
        for code, pattern in LEAK_PATTERNS:
            if pattern.search(line) and not _allow_synthetic(logical_path, line):
                issues.append({"code": code, "message": f"{logical_path}:{number}: possible credential, task value, or device path"})
    return issues


def _text_from_bytes(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _strip_fenced_blocks(text: str) -> str:
    output: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            output.append(line)
    return "\n".join(output)


def _link_issues(file_path: Path, skill_root: Path, text: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for raw_target in MARKDOWN_LINK_RE.findall(_strip_fenced_blocks(text)):
        target = raw_target.strip()
        if target.startswith("<") and ">" in target:
            target = target[1:target.index(">")]
        else:
            target = target.split(maxsplit=1)[0]
        if not target or target.startswith("#"):
            continue
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target) and not re.match(r"^[A-Za-z]:[\\/]", target):
            continue
        decoded = urllib.parse.unquote(target.split("#", 1)[0].split("?", 1)[0])
        if not decoded:
            continue
        if decoded.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", decoded):
            issues.append({"code": "absolute_link", "message": f"{file_path.relative_to(skill_root).as_posix()}: absolute local link: {target}"})
            continue
        resolved = (file_path.parent / decoded).resolve(strict=False)
        if not _within(resolved, skill_root):
            issues.append({"code": "cross_skill_link", "message": f"{file_path.relative_to(skill_root).as_posix()}: link escapes Skill: {target}"})
        elif not resolved.exists():
            issues.append({"code": "broken_link", "message": f"{file_path.relative_to(skill_root).as_posix()}: missing link target: {target}"})
    return issues


def validate_skill(repo_root: Path, entry: SkillEntry, strict: bool = False) -> dict[str, Any]:
    root = (repo_root / entry.path).resolve(strict=False)
    files, errors = _tree_files(root)
    warnings: list[dict[str, str]] = []

    def add(code: str, message: str, strict_only: bool = False) -> None:
        (errors if strict or not strict_only else warnings).append({"code": code, "message": message})

    for key, value in (
        ("version", entry.version),
        ("platform", entry.platform),
        ("maturity", entry.maturity),
        ("taskmaster_contract", entry.taskmaster_contract),
    ):
        if value is None or value == "":
            add("catalog_metadata", f"catalog field is required: {key}", strict_only=True)

    skill_md = root / "SKILL.md"
    frontmatter: dict[str, str] = {}
    if not skill_md.is_file():
        add("skill_md_missing", "SKILL.md is required")
    else:
        try:
            frontmatter = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, SkillkitError) as exc:
            add("frontmatter", str(exc))
        if frontmatter.get("name") != entry.name:
            add("frontmatter_name", f"frontmatter name must equal catalog name {entry.name!r}")
        version = frontmatter.get("version")
        if not version:
            add("frontmatter_version", "frontmatter version is required")
        elif not SEMVER_RE.fullmatch(version):
            add("frontmatter_version", f"invalid semantic version: {version}")
        elif entry.version and version != entry.version:
            add("frontmatter_version", f"frontmatter version {version} does not match catalog {entry.version}")

    release_path = root / RELEASE_METADATA_NAME
    release: dict[str, Any] | None = None
    if not release_path.is_file():
        add("release_metadata", f"{RELEASE_METADATA_NAME} is required")
    else:
        try:
            loaded = json.loads(release_path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("root must be an object")
            release = loaded
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            add("release_metadata", f"invalid {RELEASE_METADATA_NAME}: {exc}")
        if release is not None:
            required = ("schema", "name", "version", "platform", "maturity", "taskmaster_contract",
                        "no_task_config", "no_credentials", "no_real_data")
            for key in required:
                if key not in release:
                    add("release_metadata", f"missing release metadata field: {key}")
            for key in ("no_task_config", "no_credentials", "no_real_data"):
                if key in release and release[key] is not True:
                    add("release_boundary", f"{key} must be true")
            if "schema" in release and release["schema"] != 1:
                add("release_metadata", "skill-release.json.schema must equal 1")
            contract = release.get("taskmaster_contract")
            if contract is not None and not (
                isinstance(contract, str) and bool(contract.strip())
                or isinstance(contract, dict)
                and isinstance(contract.get("binding"), str)
                and isinstance(contract.get("required_capabilities"), list)
                and all(isinstance(item, str) and item for item in contract.get("required_capabilities", []))
            ):
                add("release_metadata", "taskmaster_contract must be a non-empty string or capability object")
            expected = {
                "name": entry.name,
                "version": entry.version,
                "platform": entry.platform,
                "maturity": entry.maturity,
                "taskmaster_contract": entry.taskmaster_contract,
            }
            for key, expected_value in expected.items():
                if expected_value is not None and release.get(key) != expected_value:
                    add("catalog_mismatch", f"{RELEASE_METADATA_NAME}.{key} does not match catalog")
            if isinstance(release.get("version"), str) and not SEMVER_RE.fullmatch(release["version"]):
                add("release_version", f"invalid release semantic version: {release['version']}")
            if frontmatter.get("version") and release.get("version") != frontmatter["version"]:
                add("release_version", "skill-release.json.version does not match SKILL.md frontmatter")

    for path in files:
        rel = path.relative_to(root).as_posix()
        try:
            data = path.read_bytes()
        except OSError as exc:
            add("file_read", f"cannot read {rel}: {exc}")
            continue
        text = _text_from_bytes(data)
        if text is None:
            continue
        errors.extend(scan_text(text, rel))
        if path.suffix.casefold() == ".md":
            errors.extend(_link_issues(path, root, text))

    return {
        "name": entry.name,
        "path": str(root),
        "version": entry.version,
        "passed": not errors and (not strict or not warnings),
        "errors": errors,
        "warnings": warnings,
        "files": len(files),
    }


def validate(repo_root: Path, entries: Sequence[SkillEntry], strict: bool = False) -> dict[str, Any]:
    results = [validate_skill(repo_root, entry, strict=strict) for entry in entries]
    return {"passed": all(result["passed"] for result in results), "strict": strict, "skills": results}


def _test_commands(entry: SkillEntry, repo_root: Path) -> list[tuple[list[str], Path]]:
    commands: list[tuple[list[str], Path]] = []
    skill_root = (repo_root / entry.path).resolve()
    replacements = {
        "{python}": sys.executable,
        "{python_executable}": sys.executable,
        "{repo}": str(repo_root.resolve()),
        "{repo_root}": str(repo_root.resolve()),
        "{skill}": str(skill_root),
        "{skill_root}": str(skill_root),
    }
    for index, raw in enumerate(entry.tests):
        cwd = repo_root.resolve()
        argv: Any = raw
        if isinstance(raw, dict):
            argv = raw.get("argv")
            raw_cwd = raw.get("cwd")
            if raw_cwd is not None:
                if not isinstance(raw_cwd, str):
                    raise SkillkitError(f"test cwd must be a string for {entry.name} command {index}")
                for marker, value in replacements.items():
                    raw_cwd = raw_cwd.replace(marker, value)
                cwd = (repo_root / raw_cwd).resolve(strict=False)
                if not _within(cwd, repo_root):
                    raise SkillkitError(f"test cwd escapes repository for {entry.name}")
        if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item for item in argv):
            raise SkillkitError(f"test argv must be a non-empty string array for {entry.name} command {index}")
        expanded: list[str] = []
        for item in argv:
            for marker, value in replacements.items():
                item = item.replace(marker, value)
            expanded.append(item)
        commands.append((expanded, cwd))
    return commands


def run_tests(repo_root: Path, entries: Sequence[SkillEntry]) -> dict[str, Any]:
    skill_results: list[dict[str, Any]] = []
    all_passed = True
    for entry in entries:
        commands: list[dict[str, Any]] = []
        for argv, cwd in _test_commands(entry, repo_root):
            try:
                completed = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=False)
                result = {
                    "argv": argv,
                    "cwd": str(cwd),
                    "exit_code": completed.returncode,
                    "stdout": completed.stdout,
                    "stderr": completed.stderr,
                    "passed": completed.returncode == 0,
                }
            except OSError as exc:
                result = {"argv": argv, "cwd": str(cwd), "exit_code": None, "stdout": "", "stderr": str(exc), "passed": False}
            commands.append(result)
            all_passed = all_passed and result["passed"]
        skill_results.append({"name": entry.name, "passed": all(item["passed"] for item in commands), "skipped": not commands, "commands": commands})
    return {"passed": all_passed, "skills": skill_results}


def _source_snapshot(root: Path) -> dict[str, bytes]:
    files, issues = _tree_files(root)
    if issues:
        raise SkillkitError("source tree is not portable: " + "; ".join(item["message"] for item in issues))
    snapshot: dict[str, bytes] = {}
    for path in files:
        rel = path.relative_to(root).as_posix()
        if rel == ARCHIVE_MANIFEST_NAME or rel.startswith("__pycache__/") or "/__pycache__/" in f"/{rel}/" or rel.endswith((".pyc", ".pyo")):
            continue
        snapshot[rel] = path.read_bytes()
    return snapshot


def _manifest(entry: SkillEntry, snapshot: dict[str, bytes]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "name": entry.name,
        "version": entry.version,
        "files": [
            {"path": path, "bytes": len(data), "sha256": _sha256(data)}
            for path, data in sorted(snapshot.items())
        ],
    }


def _zip_write(path: Path, root_name: str, snapshot: dict[str, bytes], manifest_data: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
            members = {ARCHIVE_MANIFEST_NAME: manifest_data}
            members.update({f"{root_name}/{rel}": data for rel, data in snapshot.items()})
            for member, data in sorted(members.items()):
                info = zipfile.ZipInfo(member, FIXED_ZIP_TIME)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def package(repo_root: Path, entries: Sequence[SkillEntry], output_dir: Path, catalog: dict[str, Any]) -> dict[str, Any]:
    check = validate(repo_root, entries, strict=True)
    if not check["passed"]:
        raise SkillkitError("strict validation failed before packaging")
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, Any]] = []
    for entry in entries:
        if not entry.version:
            raise SkillkitError(f"catalog version is required to package {entry.name}")
        root = (repo_root / entry.path).resolve()
        snapshot = _source_snapshot(root)
        manifest_data = _json_bytes(_manifest(entry, snapshot))
        archive_path = output_dir / f"{entry.name}-v{entry.version}.zip"
        _zip_write(archive_path, entry.name, snapshot, manifest_data)
        verified = verify_archive(archive_path)
        artifacts.append({
            "name": entry.name,
            "version": entry.version,
            "platform": entry.platform,
            "maturity": entry.maturity,
            "taskmaster_contract": entry.taskmaster_contract,
            "archive": archive_path.name,
            "bytes": archive_path.stat().st_size,
            "sha256": _sha256_file(archive_path),
            "files": verified["files"],
        })
    artifacts.sort(key=lambda item: item["name"])
    sums = "".join(f"{item['sha256']}  {item['archive']}\n" for item in artifacts)
    (output_dir / "SHA256SUMS").write_text(sums, encoding="utf-8", newline="\n")
    index = {
        "schema_version": 1,
        "catalog_schema_version": catalog.get("schema_version", catalog.get("version", 1)),
        "project": catalog.get("project"),
        "version": catalog.get("version"),
        "repository": catalog.get("repository"),
        "artifacts": artifacts,
    }
    (output_dir / "release-index.json").write_bytes(_json_bytes(index))
    return {"passed": True, "output": str(output_dir.resolve()), "artifacts": artifacts,
            "sha256sums": str((output_dir / "SHA256SUMS").resolve()),
            "release_index": str((output_dir / "release-index.json").resolve())}


def _zip_name_issues(infos: Sequence[zipfile.ZipInfo]) -> list[str]:
    issues: list[str] = []
    raw_seen: set[str] = set()
    canonical_paths: dict[tuple[str, ...], tuple[str, ...]] = {}
    component_names: dict[tuple[tuple[str, ...], str], str] = {}
    for info in infos:
        # ZipInfo normalizes backslashes to the host separator on Windows, but
        # orig_filename retains the member name encoded in the central record.
        raw = getattr(info, "orig_filename", info.filename)
        if raw in raw_seen:
            issues.append(f"duplicate archive member: {raw}")
        raw_seen.add(raw)
        if not raw or "\x00" in raw:
            issues.append("empty or NUL archive member")
            continue
        if "\\" in raw:
            issues.append(f"backslash archive member: {raw}")
            continue
        body = raw[:-1] if raw.endswith("/") else raw
        if not body or body.startswith("/") or re.match(r"^[A-Za-z]:", body):
            issues.append(f"absolute archive member: {raw}")
            continue
        raw_parts = body.split("/")
        if any(part in {"", ".", ".."} for part in raw_parts):
            issues.append(f"non-canonical archive member: {raw}")
            continue
        for index, part in enumerate(raw_parts):
            error = _portable_name_error(part)
            if error:
                issues.append(f"non-portable archive member {raw}: {error}")
            parent_key = tuple(unicodedata.normalize("NFC", value).casefold() for value in raw_parts[:index])
            part_key = unicodedata.normalize("NFC", part).casefold()
            slot = (parent_key, part_key)
            previous_part = component_names.get(slot)
            if previous_part is not None and previous_part != part:
                issues.append(f"Unicode/case filename collision: {previous_part} <> {part}")
            else:
                component_names[slot] = part
        key = tuple(unicodedata.normalize("NFC", part).casefold() for part in raw_parts)
        previous = canonical_paths.get(key)
        current = tuple(raw_parts)
        if previous is not None and previous != current:
            issues.append(f"Unicode/case path collision: {'/'.join(previous)} <> {body}")
        else:
            canonical_paths[key] = current
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_IFMT(mode) == stat.S_IFLNK:
            issues.append(f"symlink archive member: {raw}")
        if info.flag_bits & 0x1:
            issues.append(f"encrypted archive member: {raw}")
    return issues


def verify_archive(archive_path: Path) -> dict[str, Any]:
    archive_path = archive_path.resolve()
    if not archive_path.is_file():
        raise SkillkitError(f"archive not found: {archive_path}")
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            issues = _zip_name_issues(infos)
            file_infos = [info for info in infos if not info.is_dir()]
            envelope_infos = [info for info in file_infos if info.filename == ARCHIVE_MANIFEST_NAME]
            if len(envelope_infos) != 1:
                issues.append(f"archive must contain exactly one root {ARCHIVE_MANIFEST_NAME}")
            unexpected_root_files = [
                info.filename for info in file_infos
                if "/" not in info.filename and info.filename != ARCHIVE_MANIFEST_NAME
            ]
            if unexpected_root_files:
                issues.append(f"unexpected root archive members: {unexpected_root_files}")
            skill_infos = [info for info in file_infos if "/" in info.filename]
            roots = {info.filename.split("/", 1)[0] for info in skill_infos}
            if len(roots) != 1:
                issues.append("archive must contain exactly one top-level Skill directory")
            root = next(iter(roots), "")
            if root and not SKILL_NAME_RE.fullmatch(root):
                issues.append(f"archive root is not a valid Skill name: {root}")
            data_by_rel: dict[str, bytes] = {}
            for info in skill_infos:
                if not root or not info.filename.startswith(root + "/"):
                    continue
                rel = info.filename[len(root) + 1:]
                try:
                    data = archive.read(info)
                except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    issues.append(f"cannot read archive member {info.filename}: {exc}")
                    continue
                data_by_rel[rel] = data
                text = _text_from_bytes(data)
                if text is not None:
                    issues.extend(item["message"] for item in scan_text(text, rel))
            manifest_data: bytes | None = None
            if envelope_infos:
                try:
                    manifest_data = archive.read(envelope_infos[0])
                    manifest_text = _text_from_bytes(manifest_data)
                    if manifest_text is not None:
                        issues.extend(item["message"] for item in scan_text(manifest_text, ARCHIVE_MANIFEST_NAME))
                except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    issues.append(f"cannot read {ARCHIVE_MANIFEST_NAME}: {exc}")
            manifest: dict[str, Any] | None = None
            if manifest_data is None:
                issues.append(f"archive is missing {ARCHIVE_MANIFEST_NAME}")
            else:
                try:
                    loaded = json.loads(manifest_data.decode("utf-8"))
                    if not isinstance(loaded, dict):
                        raise ValueError("manifest root must be an object")
                    manifest = loaded
                except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
                    issues.append(f"invalid {ARCHIVE_MANIFEST_NAME}: {exc}")
            if manifest is not None:
                if manifest.get("schema_version") != 1:
                    issues.append("manifest schema_version must equal 1")
                if manifest.get("name") != root:
                    issues.append("manifest name does not match archive root")
                if not isinstance(manifest.get("version"), str) or not SEMVER_RE.fullmatch(manifest["version"]):
                    issues.append("manifest version is not valid SemVer")
                records = manifest.get("files")
                expected: dict[str, dict[str, Any]] = {}
                if not isinstance(records, list):
                    issues.append("manifest files must be a list")
                else:
                    for record in records:
                        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                            issues.append("invalid manifest file record")
                            continue
                        rel = record["path"]
                        if rel in expected:
                            issues.append(f"duplicate manifest record: {rel}")
                        expected[rel] = record
                    actual_names = set(data_by_rel)
                    if set(expected) != actual_names:
                        missing = sorted(set(expected) - actual_names)
                        extra = sorted(actual_names - set(expected))
                        issues.append(f"manifest inventory mismatch: missing={missing} extra={extra}")
                    for rel in sorted(set(expected) & actual_names):
                        data = data_by_rel[rel]
                        record = expected[rel]
                        if record.get("bytes") != len(data) or record.get("sha256") != _sha256(data):
                            issues.append(f"manifest hash or byte mismatch: {rel}")
            skill_data = data_by_rel.get("SKILL.md")
            if skill_data is None:
                issues.append("archive is missing SKILL.md")
            else:
                try:
                    frontmatter = parse_frontmatter(skill_data.decode("utf-8"))
                    if frontmatter.get("name") != root:
                        issues.append("SKILL.md name does not match archive root")
                    if manifest is not None and frontmatter.get("version") != manifest.get("version"):
                        issues.append("SKILL.md version does not match manifest")
                except (UnicodeError, SkillkitError) as exc:
                    issues.append(f"invalid archived SKILL.md: {exc}")
            release_data = data_by_rel.get(RELEASE_METADATA_NAME)
            if release_data is None:
                issues.append(f"archive is missing {RELEASE_METADATA_NAME}")
            else:
                try:
                    release = json.loads(release_data.decode("utf-8"))
                    if not isinstance(release, dict):
                        raise ValueError("release metadata root must be an object")
                    if release.get("schema") != 1:
                        issues.append("skill-release.json.schema must equal 1")
                    if release.get("name") != root:
                        issues.append("skill-release.json name does not match archive root")
                    if manifest is not None and release.get("version") != manifest.get("version"):
                        issues.append("skill-release.json version does not match manifest")
                    for key in ("no_task_config", "no_credentials", "no_real_data"):
                        if release.get(key) is not True:
                            issues.append(f"skill-release.json {key} must be true")
                except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
                    issues.append(f"invalid {RELEASE_METADATA_NAME}: {exc}")
            if issues:
                raise SkillkitError("archive verification failed: " + "; ".join(dict.fromkeys(issues)))
            return {
                "passed": True,
                "archive": str(archive_path),
                "name": root,
                "version": manifest.get("version") if manifest else None,
                "files": len(data_by_rel),
                "sha256": _sha256_file(archive_path),
            }
    except zipfile.BadZipFile as exc:
        raise SkillkitError(f"invalid ZIP archive: {archive_path}: {exc}") from exc


def resolve_skills_dir(explicit: str | Path | None, env: dict[str, str] | None = None,
                       home: Path | None = None) -> Path:
    env = os.environ if env is None else env
    if explicit:
        return Path(explicit).expanduser().resolve(strict=False)
    if env.get("SOCIAL_SKILLS_DIR"):
        return Path(env["SOCIAL_SKILLS_DIR"]).expanduser().resolve(strict=False)
    if env.get("CODEX_HOME"):
        return (Path(env["CODEX_HOME"]).expanduser() / "skills").resolve(strict=False)
    return ((home or Path.home()) / ".codex" / "skills").resolve(strict=False)


def _write_snapshot(root: Path, snapshot: dict[str, bytes]) -> None:
    for rel, data in sorted(snapshot.items()):
        target = root.joinpath(*PurePosixPath(rel).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _promote_stage(staged_root: Path, target: Path, replace: bool) -> Path | None:
    target_exists = os.path.lexists(target)
    if target_exists and not replace:
        raise SkillkitError(f"target already exists; pass --replace: {target}")
    backup: Path | None = None
    if target_exists:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = target.with_name(f"{target.name}.backup-{stamp}-{uuid.uuid4().hex[:8]}")
        os.replace(target, backup)
    try:
        os.replace(staged_root, target)
    except BaseException:
        try:
            if os.path.lexists(target):
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            if backup is not None and os.path.lexists(backup):
                os.replace(backup, target)
        except BaseException as rollback_exc:
            raise SkillkitError(f"install failed and rollback requires review: {rollback_exc}") from rollback_exc
        raise
    return backup


def install_source(repo_root: Path, entry: SkillEntry, skills_dir: Path, replace: bool) -> dict[str, Any]:
    result = validate_skill(repo_root, entry, strict=True)
    if not result["passed"]:
        raise SkillkitError(f"strict validation failed for {entry.name}")
    source = (repo_root / entry.path).resolve()
    snapshot = _source_snapshot(source)
    skills_dir.mkdir(parents=True, exist_ok=True)
    stage_parent = Path(tempfile.mkdtemp(prefix=".skillkit-install-", dir=skills_dir))
    staged_root = stage_parent / entry.name
    staged_root.mkdir()
    try:
        _write_snapshot(staged_root, snapshot)
        target = skills_dir / entry.name
        backup = _promote_stage(staged_root, target, replace)
    finally:
        shutil.rmtree(stage_parent, ignore_errors=True)
    return {"passed": True, "name": entry.name, "version": entry.version, "target": str(target),
            "backup": str(backup) if backup else None, "source": "catalog"}


def install_archive(archive_path: Path, skills_dir: Path, replace: bool) -> dict[str, Any]:
    verified = verify_archive(archive_path)
    skills_dir.mkdir(parents=True, exist_ok=True)
    stage_parent = Path(tempfile.mkdtemp(prefix=".skillkit-install-", dir=skills_dir))
    staged_root = stage_parent / verified["name"]
    staged_root.mkdir()
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            prefix = verified["name"] + "/"
            for info in archive.infolist():
                if info.is_dir() or not info.filename.startswith(prefix):
                    continue
                rel = info.filename[len(prefix):]
                target_file = staged_root.joinpath(*PurePosixPath(rel).parts)
                if not _within(target_file, staged_root):
                    raise SkillkitError(f"archive member escapes install stage: {info.filename}")
                target_file.parent.mkdir(parents=True, exist_ok=True)
                target_file.write_bytes(archive.read(info))
        target = skills_dir / verified["name"]
        backup = _promote_stage(staged_root, target, replace)
    finally:
        shutil.rmtree(stage_parent, ignore_errors=True)
    return {"passed": True, "name": verified["name"], "version": verified["version"],
            "target": str(target), "backup": str(backup) if backup else None, "source": "archive"}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, help="catalog.json path (defaults to repository root)")
    sub = parser.add_subparsers(dest="command", required=True)

    def selector(command: str) -> argparse.ArgumentParser:
        item = sub.add_parser(command)
        group = item.add_mutually_exclusive_group(required=True)
        group.add_argument("--all", action="store_true")
        group.add_argument("--skill")
        return item

    validate_parser = selector("validate")
    validate_parser.add_argument("--strict", action="store_true")
    selector("test")
    package_parser = selector("package")
    package_parser.add_argument("--output", type=Path, required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--archive", type=Path, required=True)
    install_parser = sub.add_parser("install")
    install_source_group = install_parser.add_mutually_exclusive_group(required=True)
    install_source_group.add_argument("--skill")
    install_source_group.add_argument("--archive", type=Path)
    install_parser.add_argument("--skills-dir")
    install_parser.add_argument("--replace", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    repo_root = args.catalog.resolve().parent if args.catalog is not None else _repo_root()
    try:
        if args.command == "verify":
            result = verify_archive(args.archive)
        elif args.command == "install" and args.archive is not None:
            result = install_archive(args.archive, resolve_skills_dir(args.skills_dir), args.replace)
        else:
            catalog, entries = load_catalog(repo_root, args.catalog)
            if args.command == "install":
                selected = select_entries(entries, args.skill, False)
                result = install_source(repo_root, selected[0], resolve_skills_dir(args.skills_dir), args.replace)
            else:
                selected = select_entries(entries, getattr(args, "skill", None), getattr(args, "all", False))
                if args.command == "validate":
                    result = validate(repo_root, selected, strict=args.strict)
                elif args.command == "test":
                    result = run_tests(repo_root, selected)
                elif args.command == "package":
                    result = package(repo_root, selected, args.output.resolve(strict=False), catalog)
                else:  # pragma: no cover - argparse prevents this
                    raise SkillkitError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if result.get("passed", False) else 1
    except (SkillkitError, OSError, ValueError) as exc:
        print(json.dumps({"passed": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
