#!/usr/bin/env python3
"""Validate and release the TikTok three-Skill unit without changing single-Skill packaging."""
from __future__ import annotations
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path
import skillkit

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "bundles" / "tiktok-discovery"
EVOLVE = Path("skills/tiktok-discovery-retrospective/scripts/evolve.mjs")
MEMBERS = ["tiktok-seed-discovery", "tiktok-seed-expansion", "tiktok-discovery-retrospective"]

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def read_json(file: Path):
    return json.loads(file.read_text(encoding="utf-8"))

def write_json(file: Path, value):
    # Preserve native inventory record order: its installer compares exact inventories.
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

def node(*args: str | Path):
    result = subprocess.run(["node", *map(str, args)], cwd=ROOT, text=True, encoding="utf-8", capture_output=True)
    if result.returncode:
        diagnostics = result.stdout + result.stderr
        if "--out" in args:
            log = Path(args[args.index("--out") + 1]) / "validation.tap"
            if log.is_file():
                diagnostics += "\n" + log.read_text(encoding="utf-8")
        raise skillkit.SkillkitError(diagnostics)
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise skillkit.SkillkitError("Node CLI returned no valid JSON: " + str(args[0]) + "\n" + result.stdout + result.stderr) from error

def scan_source():
    files, issues = skillkit._tree_files(BUNDLE)
    for file in files:
        text = skillkit._text_from_bytes(file.read_bytes())
        if text is None:
            issues.append({"code": "binary", "message": file.relative_to(BUNDLE).as_posix()})
        else:
            issues.extend(skillkit.scan_text(text, file.relative_to(BUNDLE).as_posix()))
    if issues:
        raise skillkit.SkillkitError(json.dumps(issues, ensure_ascii=False))
    catalog = read_json(ROOT / "catalog.json")
    entries = [entry for entry in catalog.get("bundles", []) if entry["name"] == "tiktok-discovery"]
    metadata = read_json(BUNDLE / "skills/tiktok-discovery-retrospective/release.json")
    if len(entries) != 1 or entries[0]["path"] != BUNDLE.relative_to(ROOT).as_posix() or entries[0]["version"] != metadata["version"] or entries[0]["members"] != MEMBERS:
        raise skillkit.SkillkitError("TikTok bundle catalog/version/member mismatch")
    return entries[0]

def build_native(work: Path):
    entry = scan_source()
    checked = node(BUNDLE / EVOLVE, "check", "--source", BUNDLE, "--out", work / "validation")
    release = work / "release"
    node(BUNDLE / EVOLVE, "package", "--source", BUNDLE, "--validation", work / "validation/validation.json", "--out", release)
    # Keep source-backed offline checks, without varying host/time fields in deterministic assets.
    qa_file = release / "QA.json"
    qa = read_json(qa_file)
    for key in ["createdAt", "actualHost", "nodeVersion"]:
        qa.pop(key, None)
    qa["evidenceScope"] = "Offline synthetic behavior checks; runner OS and Node details are in the corresponding CI run."
    write_json(qa_file, qa)
    manifest_file = release / "manifest.json"
    manifest = read_json(manifest_file)
    for record in manifest["files"]:
        if record["path"] == "QA.json":
            data = qa_file.read_bytes()
            record.update(bytes=len(data), sha256=digest(data))
    write_json(manifest_file, manifest)
    return entry, checked, release

def verify_native_archive(archive: Path):
    with zipfile.ZipFile(archive) as zf:
        issues = skillkit._zip_name_issues(zf.infolist())
        if issues:
            raise skillkit.SkillkitError("; ".join(issues))
        manifest = json.loads(zf.read("manifest.json"))
        records = manifest.get("files", [])
        expected = [record["path"] for record in records]
        if len(expected) != len(set(expected)) or set(zf.namelist()) != set(expected) | {"manifest.json"}:
            raise skillkit.SkillkitError("Native bundle inventory mismatch")
        for record in records:
            data = zf.read(record["path"])
            if len(data) != record["bytes"] or digest(data) != record["sha256"]:
                raise skillkit.SkillkitError("Native bundle hash mismatch: " + record["path"])
            text = skillkit._text_from_bytes(data)
            if text is None or skillkit.scan_text(text, record["path"]):
                raise skillkit.SkillkitError("Native bundle scan failed: " + record["path"])
        for name in MEMBERS:
            if "skills/" + name + "/SKILL.md" not in expected:
                raise skillkit.SkillkitError("Missing bundled Skill: " + name)
        return {"version": manifest["packageVersion"], "files": len(expected) + 1}

def write_archive(release: Path, archive: Path):
    files, issues = skillkit._tree_files(release)
    if issues:
        raise skillkit.SkillkitError(str(issues))
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file in files:
            info = zipfile.ZipInfo(file.relative_to(release).as_posix(), skillkit.FIXED_ZIP_TIME)
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, file.read_bytes(), compresslevel=9)
    return verify_native_archive(archive)

def validate():
    with tempfile.TemporaryDirectory(prefix="tk-bundle-") as temporary:
        work = Path(temporary)
        _, checked, release = build_native(work)
        archive = work / "bundle.zip"
        verified = write_archive(release, archive)
        # Install an extracted archive, then rebuild using only installed tools.
        extracted = work / "解包 空格"
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(extracted)  # Names/types/inventory/hashes verified immediately above.
        installed = work / "安装 技能"
        receipt = node(extracted / "install.mjs", "--skills-dir", installed)
        entry = installed / "tiktok-discovery-retrospective/scripts/evolve.mjs"
        candidate = work / "candidate"
        node(entry, "stage", "--skills-dir", installed, "--out", candidate)
        rebuilt = node(entry, "check", "--source", candidate, "--out", work / "installed-validation")
        if checked["payloadHash"] != rebuilt["payloadHash"]:
            raise skillkit.SkillkitError("Installed rebuild differs from source")
        return {"passed": True, "bundle": "tiktok-discovery", "tests": checked["offlineTests"],
                "native_archive": verified, "isolated_install": receipt["status"], "installed_rebuild": "identical"}

def package(output: Path):
    index_file = output / "release-index.json"
    if not index_file.is_file():
        raise skillkit.SkillkitError("Build the independent Skill assets first with skillkit.py package --all")
    with tempfile.TemporaryDirectory(prefix="tk-package-") as temporary:
        entry, checked, release = build_native(Path(temporary))
        archive = output / ("tiktok-discovery-three-skills-v" + entry["version"] + ".zip")
        verified = write_archive(release, archive)
        artifact = {"name": entry["name"], "type": "bundle", "members": MEMBERS, "version": entry["version"],
                    "platform": "tiktok", "maturity": entry["maturity"], "archive": archive.name,
                    "bytes": archive.stat().st_size, "sha256": digest(archive.read_bytes()), "files": verified["files"],
                    "installer": "node install.mjs", "integrity": "native manifest.json"}
        index = read_json(index_file)
        if any(item["name"] == entry["name"] for item in index["artifacts"]):
            raise skillkit.SkillkitError("Bundle already indexed; use a fresh output directory")
        index["artifacts"] = sorted([*index["artifacts"], artifact], key=lambda item: item["name"])
        write_json(index_file, index)
        (output / "SHA256SUMS").write_text("".join(item["sha256"] + "  " + item["archive"] + "\n" for item in index["artifacts"]), encoding="utf-8", newline="\n")
        return {"passed": True, "artifact": artifact, "tests": checked["offlineTests"]}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "package", "verify"])
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    if args.command == "verify" and args.archive is None:
        parser.error("--archive is required for verify")
    result = validate() if args.command == "validate" else package(args.output.resolve()) if args.command == "package" else verify_native_archive(args.archive.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
if __name__ == "__main__":
    main()
