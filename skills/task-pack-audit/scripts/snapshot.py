#!/usr/bin/env python3
"""Bind an audit to exact release files; this does not perform semantic review."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def is_link(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def inventory(root):
    root = Path(root).absolute()
    if not root.is_dir() or is_link(root):
        raise ValueError("Release unit must be an ordinary directory")
    records = []
    for current, directories, files in os.walk(root, followlinks=False, onerror=_raise):
        for name in sorted(directories + files):
            path = Path(current) / name
            if is_link(path):
                raise ValueError("Links and reparse points are not supported")
            if name in directories:
                continue
            if not stat.S_ISREG(path.stat().st_mode):
                raise ValueError("Only regular files are supported")
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as handle:
                for data in iter(lambda: handle.read(1024 * 1024), b""):
                    size += len(data)
                    digest.update(data)
            records.append({"path": path.relative_to(root).as_posix(),
                            "bytes": size, "sha256": digest.hexdigest()})
    if not records:
        raise ValueError("Release unit is empty")
    records.sort(key=lambda item: item["path"])
    return {"schema": 1, "scope": "file-identity-only", "files": records}


def _raise(error):
    raise error


def create(root, snapshot):
    root, snapshot = Path(root).absolute(), Path(snapshot).absolute()
    if snapshot.resolve().is_relative_to(root.resolve()):
        raise ValueError("Snapshot must be outside the release unit")
    data = inventory(root)
    # Exclusive creation preserves a prior review's evidence.
    with snapshot.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return {"status": "snapshot_created", "files": len(data["files"]),
            "semantic_audit": "not_performed"}


def verify(root, snapshot):
    expected = json.loads(Path(snapshot).read_text(encoding="utf-8"))
    actual = inventory(root)
    if expected != actual:
        raise ValueError("Snapshot differs from the current release files")
    return {"status": "files_match", "files": len(actual["files"]),
            "semantic_audit": "not_performed"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "verify"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = (create if args.action == "create" else verify)(args.root, args.snapshot)
    except (OSError, ValueError) as error:
        # Do not echo file contents, source values, or exception paths into CI.
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        print(json.dumps({"status": "error", "reason": message}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
