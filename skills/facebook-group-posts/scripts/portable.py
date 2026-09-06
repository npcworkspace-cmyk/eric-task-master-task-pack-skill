#!/usr/bin/env python3
"""Portable doctor, verifier, packager, and transactional installer for this Skill."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


NAME = "facebook-group-posts"
MANIFEST = "pack-manifest.json"
RELEASE_ROOT_FILES = {"LICENSE", "THIRD_PARTY_NOTICES.md", "skill-release.json"}
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
REQUIRED = {
    "SKILL.md",
    "agents/openai.yaml",
    "references/evolution.md",
    "references/portable-deployment.md",
    "scripts/audit_export.py",
    "scripts/batches.mjs",
    "scripts/collect.mjs",
    "scripts/evolve.py",
    "scripts/portable.py",
    "scripts/prepare.mjs",
    "tests/test-audit-export.py",
    "tests/test-batches.mjs",
    "tests/test-collector.mjs",
    "tests/test-evolve.py",
    "tests/test-portable.py",
}
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{value}" for value in range(1, 10)), *(f"LPT{value}" for value in range(1, 10))}


def fail(message: str) -> None:
    raise ValueError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_reparse(path: Path) -> bool:
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & 0x400)


def allowed(relative: str) -> bool:
    value = PurePosixPath(relative)
    if value.is_absolute() or ".." in value.parts or len(value.parts) not in (1, 2):
        return False
    if relative in {"SKILL.md", MANIFEST, "agents/openai.yaml", *RELEASE_ROOT_FILES}:
        return True
    if len(value.parts) != 2:
        return False
    folder, name = value.parts
    return (
        (folder == "scripts" and (name.endswith(".py") or name.endswith(".mjs")))
        or (folder == "tests" and name.startswith("test-") and (name.endswith(".py") or name.endswith(".mjs")))
        or (folder == "references" and name.endswith(".md"))
        or (folder == "assets" and name.endswith("-template.json"))
    )


def validate_portable_names(names) -> None:
    seen: dict[str, str] = {}
    for name in names:
        if unicodedata.normalize("NFC", name) != name:
            fail("NON_NFC_SKILL_PATH: " + name)
        parts = PurePosixPath(name).parts
        for part in parts:
            if (not part or part.endswith((".", " "))
                    or any(char in part for char in '<>"|?*:\\')
                    or any(ord(char) < 32 for char in part)):
                fail("NON_PORTABLE_SKILL_PATH: " + name)
            if part.split(".", 1)[0].upper() in WINDOWS_RESERVED:
                fail("WINDOWS_RESERVED_SKILL_PATH: " + name)
        key = unicodedata.normalize("NFC", name).casefold()
        if key in seen and seen[key] != name:
            fail("CASE_OR_UNICODE_PATH_COLLISION: " + seen[key] + " <> " + name)
        seen[key] = name


def inventory(root: Path) -> dict[str, dict[str, object]]:
    raw_root = Path(root).absolute()
    if not raw_root.is_dir() or is_reparse(raw_root):
        fail("SKILL_ROOT_MUST_BE_A_REAL_DIRECTORY")
    root = raw_root.resolve()
    result: dict[str, dict[str, object]] = {}
    for path in sorted(root.rglob("*")):
        if is_reparse(path):
            fail("SYMLINK_OR_REPARSE_POINT_NOT_ALLOWED")
        if path.is_dir():
            continue
        relative = path.relative_to(root).as_posix()
        if not allowed(relative):
            fail("UNDECLARED_OR_UNSAFE_SKILL_FILE: " + relative)
        result[relative] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    validate_portable_names(result)
    missing = sorted(REQUIRED - set(result))
    if missing:
        fail("REQUIRED_SKILL_FILES_MISSING: " + ", ".join(missing))
    return result


def read_manifest_bytes(data: bytes) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("INVALID_UTF8_MANIFEST") from error
    if not isinstance(value, dict):
        fail("INVALID_MANIFEST")
    return value


def validate_manifest(manifest: dict, actual: dict[str, dict[str, object]]) -> None:
    if manifest.get("name") != NAME:
        fail("WRONG_SKILL_NAME")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
        fail("SEMANTIC_VERSION_REQUIRED")
    if manifest.get("includes_real_posts") is not False or manifest.get("includes_credentials") is not False:
        fail("PRIVATE_OR_REAL_DATA_FLAG_MUST_BE_FALSE")
    if manifest.get("includes_task_configuration") is not False:
        fail("TASK_CONFIGURATION_FLAG_MUST_BE_FALSE")
    if manifest.get("portable_schema_version") != 1:
        fail("PORTABLE_SCHEMA_VERSION_REQUIRED")
    declared = manifest.get("files")
    if not isinstance(declared, list):
        fail("MANIFEST_FILES_REQUIRED")
    mapped: dict[str, dict[str, object]] = {}
    for item in declared:
        if not isinstance(item, dict):
            fail("INVALID_MANIFEST_FILE_ENTRY")
        name = item.get("path")
        if not isinstance(name, str) or not allowed(name) or name == MANIFEST or name in mapped:
            fail("INVALID_OR_DUPLICATE_MANIFEST_PATH")
        mapped[name] = {"bytes": item.get("bytes"), "sha256": item.get("sha256")}
    validate_portable_names(mapped)
    expected = {name: value for name, value in actual.items() if name != MANIFEST}
    if mapped != expected:
        fail("MANIFEST_CONTENT_MISMATCH")


def private_path_patterns() -> list[re.Pattern[str]]:
    slash = chr(47)
    backslash = chr(92)
    drive_separator = rf"(?:{re.escape(backslash * 2)}|{re.escape(backslash)}|{slash})"
    windows_drive = rf"(?i)(?<![a-z0-9{re.escape(backslash)}])[a-z]:{drive_separator}(?=[^{re.escape(slash + backslash)}\s'\"<>])[^\s'\"<>]+"
    unc_part = rf"[^{re.escape(slash + backslash)}\s'\"<>]+"
    windows_unc = rf"(?i)(?<![-a-z0-9._{re.escape(backslash)}])(?:{re.escape(backslash * 4)}{unc_part}{re.escape(backslash * 2)}|{re.escape(backslash * 2)}{unc_part}{re.escape(backslash)}){unc_part}(?:{re.escape(backslash)}+[^\s'\"<>]+)?"
    posix_root = rf"(?i)(?<![:/a-z0-9._-]){slash}root{slash}[^\s'\"<>]+"
    posix_device = rf"(?i)(?<![:/a-z0-9._-]){slash}(?:Users|home|mnt|Volumes){slash}[^\s/'\"<>]+(?:{slash}[^\s'\"<>]+)?"
    return [re.compile(value) for value in (windows_drive, windows_unc, posix_root, posix_device)]


def credential_patterns() -> list[re.Pattern[str]]:
    return [
        re.compile(r"(?i)\bc_user\s*=\s*\d{5,}"),
        re.compile(r"(?i)\b(?:access[_-]?token|api[_-]?key|authorization)\s*[:=]\s*['\"]?[a-z0-9._-]{16,}"),
        re.compile(r"(?i)\bbearer\s+[a-z0-9._-]{20,}"),
    ]


def scan_text_files(files: dict[str, bytes], forbidden_tokens: list[str] | None = None) -> None:
    tokens = []
    for token in forbidden_tokens or []:
        if not isinstance(token, str) or len(token.strip()) < 4:
            fail("FORBIDDEN_TOKEN_MUST_HAVE_AT_LEAST_FOUR_CHARACTERS")
        tokens.append(token.casefold())
    group_pattern = re.compile(
        r"https?://(?:www\.|m\.)?facebook\.com/groups/([^/?#\s'\"<>]+)/?",
        re.IGNORECASE,
    )
    fixture_group = re.compile(r"(?:synthetic|fixture|example|test)(?:[._-][a-z0-9._-]+)?", re.IGNORECASE)
    placeholders = {"GROUP_SLUG", "GROUP_ID", "GROUP_NAME"}
    for name, data in files.items():
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("NON_UTF8_SKILL_FILE: " + name) from error
        decoded = text.replace(chr(92) + "/", "/")
        decoded = re.sub(r"(?i)\\u002f", "/", decoded)
        decoded = re.sub(r"(?i)\\u005c", lambda _: chr(92), decoded)
        decoded = re.sub(r"(?i)\\u003a", ":", decoded)
        variants = (text,) if decoded == text else (text, decoded)
        for variant in variants:
            for pattern in private_path_patterns():
                if pattern.search(variant):
                    fail("DEVICE_SPECIFIC_HOME_PATH_FOUND: " + name)
            for pattern in credential_patterns():
                if pattern.search(variant):
                    fail("POSSIBLE_CREDENTIAL_FOUND: " + name)
            for match in group_pattern.finditer(variant):
                raw_value = match.group(1)
                dynamic_template = bool(re.fullmatch(r"\$\{[^{}]+\}", raw_value))
                if not dynamic_template and raw_value not in placeholders and not fixture_group.fullmatch(raw_value):
                    fail("CONCRETE_FACEBOOK_GROUP_URL_FOUND: " + name)
        for token in tokens:
            if any(token in variant.casefold() for variant in variants):
                fail("CALLER_FORBIDDEN_TASK_TOKEN_FOUND: " + name)


def validate_tree(root: Path, forbidden_tokens: list[str] | None = None) -> dict:
    raw_root = Path(root).absolute()
    actual = inventory(raw_root)
    root = raw_root.resolve()
    manifest_path = root / MANIFEST
    manifest = read_manifest_bytes(manifest_path.read_bytes())
    validate_manifest(manifest, actual)
    content = {name: (root / name).read_bytes() for name in actual}
    scan_text_files(content, forbidden_tokens)
    return {"root": str(root), "manifest": manifest, "files": actual}


def archive_members(archive: Path) -> tuple[dict, dict[str, bytes]]:
    archive = archive.resolve()
    if not archive.is_file():
        fail("ARCHIVE_NOT_FOUND")
    with zipfile.ZipFile(archive, "r") as handle:
        names = [item.filename for item in handle.infolist()]
        if len(names) != len(set(names)):
            fail("DUPLICATE_ARCHIVE_MEMBER")
        files: dict[str, bytes] = {}
        relative_names: list[str] = []
        for item in handle.infolist():
            name = item.filename
            if "\\" in name:
                fail("UNSAFE_ARCHIVE_MEMBER: " + name)
            path = PurePosixPath(name)
            if item.is_dir() or path.is_absolute() or ".." in path.parts or len(path.parts) not in (2, 3) or path.parts[0] != NAME:
                fail("UNSAFE_ARCHIVE_MEMBER: " + name)
            relative = "/".join(path.parts[1:])
            if name != f"{NAME}/{relative}":
                fail("NON_CANONICAL_ARCHIVE_MEMBER: " + name)
            if not allowed(relative):
                fail("UNDECLARED_OR_UNSAFE_ARCHIVE_FILE: " + name)
            if relative in files:
                fail("DUPLICATE_CANONICAL_ARCHIVE_MEMBER: " + name)
            mode = item.external_attr >> 16
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                fail("ARCHIVE_SYMLINK_NOT_ALLOWED")
            files[relative] = handle.read(item)
            relative_names.append(relative)
    validate_portable_names(relative_names)
    if MANIFEST not in files:
        fail("ARCHIVE_MANIFEST_MISSING")
    manifest = read_manifest_bytes(files[MANIFEST])
    actual = {name: {"bytes": len(data), "sha256": sha256_bytes(data)} for name, data in files.items()}
    missing = sorted(REQUIRED - set(actual))
    if missing:
        fail("REQUIRED_SKILL_FILES_MISSING: " + ", ".join(missing))
    validate_manifest(manifest, actual)
    expected = set(manifest_entry["path"] for manifest_entry in manifest["files"]) | {MANIFEST}
    if set(files) != expected:
        fail("ARCHIVE_MEMBER_SET_MISMATCH")
    return manifest, files


def verify_archive(archive: Path, forbidden_tokens: list[str] | None = None) -> dict:
    manifest, files = archive_members(archive)
    scan_text_files(files, forbidden_tokens)
    return {
        "verified": True,
        "archive": str(archive.resolve()),
        "archive_sha256": sha256_file(archive.resolve()),
        "name": manifest["name"],
        "version": manifest["version"],
        "members": len(files),
        "task_configuration_included": False,
    }


def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def package_skill(root: Path, output: Path, forbidden_tokens: list[str] | None = None) -> dict:
    checked = validate_tree(root, forbidden_tokens)
    root = Path(checked["root"])
    output = output.expanduser().resolve()
    if output.suffix.casefold() != ".zip":
        fail("OUTPUT_MUST_BE_ZIP")
    if output == root or root in output.parents:
        fail("ARCHIVE_MUST_STAY_OUTSIDE_SKILL")
    if output.exists():
        fail("OUTPUT_ALREADY_EXISTS")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.parent / ("." + output.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as handle:
            for name in sorted(checked["files"]):
                handle.writestr(zip_info(f"{NAME}/{name}"), (root / name).read_bytes())
        verify_archive(temporary, forbidden_tokens)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return verify_archive(output, forbidden_tokens)


def resolve_program(value: str | None, default: str | None = None) -> str | None:
    candidate = value or default
    if not candidate:
        return None
    expanded = Path(candidate).expanduser()
    if expanded.is_absolute() or any(separator in candidate for separator in ("/", "\\")):
        if not expanded.is_file() or (os.name != "nt" and not os.access(expanded, os.X_OK)):
            return None
        return str(expanded.resolve())
    found = shutil.which(candidate)
    return str(Path(found).resolve()) if found else None


def resolve_skills_dir(explicit: str | None = None, env: dict[str, str] | None = None, home: Path | None = None) -> Path:
    env = os.environ if env is None else env
    if explicit:
        return Path(explicit).expanduser().resolve()
    if env.get("FB_GROUP_POSTS_SKILLS_DIR"):
        return Path(env["FB_GROUP_POSTS_SKILLS_DIR"]).expanduser().resolve()
    if env.get("CODEX_HOME"):
        return (Path(env["CODEX_HOME"]).expanduser() / "skills").resolve()
    return ((home or Path.home()) / ".codex" / "skills").resolve()


def resolve_taskmaster(explicit: str | None = None, env: dict[str, str] | None = None) -> str | None:
    env = os.environ if env is None else env
    for value in (explicit, env.get("ERIC_TASK_MASTER_CLI"), "taskmaster"):
        result = resolve_program(value)
        if result:
            return result
    if os.name == "nt" and env.get("LOCALAPPDATA"):
        fallback = Path(env["LOCALAPPDATA"]) / "Programs" / "Eric Task Master" / "bin" / "taskmaster.cmd"
        if fallback.is_file():
            return str(fallback.resolve())
    return None


def taskmaster_launcher_compatible(value: str | None) -> tuple[bool, str]:
    if not value:
        return False, "not_found"
    path = Path(value)
    if not path.is_file():
        return False, "not_a_file"
    if os.name != "nt":
        return (True, "posix_executable") if os.access(path, os.X_OK) else (False, "not_executable")
    if path.suffix.casefold() == ".cmd":
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False, "wrapper_unreadable"
        pattern = re.compile(r'"%~dp0\.\.\\runtime\\node\.exe"\s+"%~dp0\.\.\\app\\src\\cli\.mjs"\s+%\*', re.IGNORECASE)
        runtime = path.parent.parent / "runtime" / "node.exe"
        cli = path.parent.parent / "app" / "src" / "cli.mjs"
        if not pattern.search(source):
            return False, "unsupported_cmd_layout"
        return (True, "verified_cmd_layout") if runtime.is_file() and cli.is_file() else (False, "bundled_runtime_missing")
    if path.suffix.casefold() == ".bat":
        return False, "unsupported_bat_launcher"
    return True, "native_windows_executable"


def taskmaster_skill_compatible(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        source = path.read_text(encoding="utf-8")[:65536]
    except (OSError, UnicodeDecodeError):
        return False
    return bool(re.search(r"(?m)^name:\s*eric-task-master\s*$", source))


def runtime_version(executable: str | None) -> dict:
    if not executable:
        return {"found": False, "path": None, "version": None}
    try:
        completed = subprocess.run(
            [executable, "--version"], shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"found": False, "path": executable, "version": None}
    version = (completed.stdout or completed.stderr or "").strip().splitlines()
    return {"found": completed.returncode == 0, "path": executable, "version": version[0] if version else None}


def doctor(root: Path, node: str | None = None, taskmaster: str | None = None,
           skills_dir: str | None = None, require: str = "offline",
           forbidden_tokens: list[str] | None = None) -> tuple[dict, bool]:
    tree_error = None
    try:
        checked = validate_tree(root, forbidden_tokens)
    except Exception as error:  # doctor reports all readiness dimensions in one result
        checked = None
        tree_error = str(error)
    node_info = runtime_version(resolve_program(node or os.environ.get("FB_GROUP_POSTS_NODE"), "node"))
    node_match = re.match(r"v?(\d+)", node_info["version"] or "")
    node_info["supported"] = bool(node_info["found"] and node_match and int(node_match.group(1)) >= 18)
    python_ok = sys.version_info >= (3, 10)
    taskmaster_path = resolve_taskmaster(taskmaster)
    taskmaster_compatible, taskmaster_detail = taskmaster_launcher_compatible(taskmaster_path)
    skills = resolve_skills_dir(skills_dir)
    taskmaster_skill = skills / "eric-task-master" / "SKILL.md"
    taskmaster_skill_valid = taskmaster_skill_compatible(taskmaster_skill)
    manifest_ok = checked is not None
    offline_ready = manifest_ok and python_ok and node_info["supported"]
    collection_ready = offline_ready and taskmaster_compatible and taskmaster_skill_valid
    result = {
        "doctor": True,
        "platform": sys.platform,
        "skill_root": str(root.resolve()),
        "version": checked["manifest"]["version"] if checked else None,
        "manifest_valid": manifest_ok,
        "manifest_error": tree_error,
        "python": {"found": python_ok, "path": str(Path(sys.executable).resolve()), "version": sys.version.split()[0]},
        "node": node_info,
        "openpyxl": {"found": importlib.util.find_spec("openpyxl") is not None, "required_for": "optional XLSX export"},
        "taskmaster_cli": {"found": taskmaster_path is not None, "compatible": taskmaster_compatible,
                           "detail": taskmaster_detail, "path": taskmaster_path},
        "taskmaster_skill": {"found": taskmaster_skill.is_file(), "identity_valid": taskmaster_skill_valid,
                             "path": str(taskmaster_skill)},
        "skills_dir": str(skills),
        "offline_ready": offline_ready,
        "collection_ready": collection_ready,
        "task_configuration_included": False,
        "next": "Provide each collection task's URL, time range, Profile, stop conditions, workspace, and checkpoint outside the Skill.",
    }
    ready = manifest_ok if require == "package" else offline_ready if require == "offline" else collection_ready
    return result, ready


def copy_verified_tree(source: Path, destination: Path, files: dict[str, dict[str, object]]) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    for name in sorted(files):
        target = (destination / Path(name)).resolve()
        if not target.is_relative_to(destination.resolve()):
            fail("STAGED_INSTALL_PATH_ESCAPE")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / Path(name), target)
    if inventory(destination) != files:
        fail("STAGED_INSTALL_HASH_MISMATCH")


def install_source(source: Path, skills_dir: Path, replace: bool = False,
                   forbidden_tokens: list[str] | None = None) -> dict:
    checked = validate_tree(source, forbidden_tokens)
    source = Path(checked["root"])
    skills_dir = skills_dir.expanduser().resolve()
    skills_dir.mkdir(parents=True, exist_ok=True)
    target = skills_dir / NAME
    if target.exists() and is_reparse(target):
        fail("TARGET_REPARSE_POINT_NOT_ALLOWED")
    if target.exists() and target.resolve() == source:
        return {"installed": True, "status": "already_current", "target": str(target), "backup": None,
                "version": checked["manifest"]["version"]}
    if target.exists():
        try:
            if inventory(target) == checked["files"]:
                return {"installed": True, "status": "already_current", "target": str(target), "backup": None,
                        "version": checked["manifest"]["version"]}
        except Exception:
            pass
        if not replace:
            fail("TARGET_EXISTS_USE_REPLACE")
    stage = skills_dir / (f".{NAME}.install-{uuid.uuid4().hex}")
    backup: Path | None = None
    activated = False
    try:
        copy_verified_tree(source, stage, checked["files"])
        if target.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = skills_dir / f"{NAME}.backup-{stamp}-{uuid.uuid4().hex[:8]}"
            os.replace(target, backup)
        try:
            os.replace(stage, target)
            activated = True
        except Exception:
            if backup is not None and backup.exists() and not target.exists():
                os.replace(backup, target)
            raise
        if inventory(target) != checked["files"]:
            fail("INSTALLED_HASH_MISMATCH")
    except Exception:
        if activated and target.exists():
            failed = skills_dir / (f".{NAME}.failed-{uuid.uuid4().hex}")
            os.replace(target, failed)
        if backup is not None and backup.exists() and not target.exists():
            os.replace(backup, target)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {"installed": True, "status": "installed", "target": str(target),
            "backup": str(backup) if backup else None, "version": checked["manifest"]["version"]}


def extract_verified_archive(archive: Path, destination: Path,
                             forbidden_tokens: list[str] | None = None) -> Path:
    manifest, files = archive_members(archive)
    scan_text_files(files, forbidden_tokens)
    root = destination / NAME
    root.mkdir(parents=True, exist_ok=False)
    for name, data in files.items():
        target = (root / Path(name)).resolve()
        if not target.is_relative_to(root.resolve()):
            fail("ARCHIVE_EXTRACTION_PATH_ESCAPE")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    checked = validate_tree(root, forbidden_tokens)
    if checked["manifest"]["version"] != manifest["version"]:
        fail("EXTRACTED_VERSION_MISMATCH")
    return root


def install_archive(archive: Path, skills_dir: Path, replace: bool = False,
                    forbidden_tokens: list[str] | None = None) -> dict:
    with tempfile.TemporaryDirectory(prefix="fb-skill-install-") as folder:
        source = extract_verified_archive(archive, Path(folder), forbidden_tokens)
        return install_source(source, skills_dir, replace, forbidden_tokens)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="action", required=True)
    doctor_command = sub.add_parser("doctor", help="check the Skill and local runtime without opening a browser")
    doctor_command.add_argument("--skill-root", default=str(Path(__file__).resolve().parents[1]))
    doctor_command.add_argument("--node")
    doctor_command.add_argument("--taskmaster")
    doctor_command.add_argument("--skills-dir")
    doctor_command.add_argument("--require", choices=("package", "offline", "collection"), default="offline")
    doctor_command.add_argument("--forbid-token", action="append", default=[])
    package_command = sub.add_parser("package", help="create a verified, task-neutral portable ZIP")
    package_command.add_argument("--skill-root", default=str(Path(__file__).resolve().parents[1]))
    package_command.add_argument("--output", required=True)
    package_command.add_argument("--forbid-token", action="append", default=[])
    verify_command = sub.add_parser("verify", help="verify a portable ZIP without extracting it")
    verify_command.add_argument("--archive", required=True)
    verify_command.add_argument("--forbid-token", action="append", default=[])
    install_command = sub.add_parser("install", help="transactionally install a verified source folder or ZIP")
    source = install_command.add_mutually_exclusive_group(required=True)
    source.add_argument("--source")
    source.add_argument("--archive")
    install_command.add_argument("--skills-dir")
    install_command.add_argument("--replace", action="store_true")
    install_command.add_argument("--forbid-token", action="append", default=[])
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.action == "doctor":
        result, ready = doctor(Path(args.skill_root), args.node, args.taskmaster, args.skills_dir, args.require, args.forbid_token)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if ready else 2
    if args.action == "package":
        result = package_skill(Path(args.skill_root), Path(args.output), args.forbid_token)
    elif args.action == "verify":
        result = verify_archive(Path(args.archive), args.forbid_token)
    else:
        skills = resolve_skills_dir(args.skills_dir)
        result = install_source(Path(args.source), skills, args.replace, args.forbid_token) if args.source else install_archive(Path(args.archive), skills, args.replace, args.forbid_token)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
