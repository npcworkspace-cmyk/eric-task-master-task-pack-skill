# Release process

1. Update the affected Skill version in `catalog.json` and `CHANGELOG.md`.
2. Run strict validation and all synthetic behavior tests.
3. Build deterministic archives with `tools/skillkit.py package --all --output dist`,
   then `tools/tiktok_bundle.py package --output dist` to append the complete
   TikTok bundle to the same index and SHA256SUMS.
4. Install every archive into a fresh Unicode-and-space directory and validate
   the installed copy.
5. Review `release-index.json`, `SHA256SUMS`, maturity labels, and compatibility
   evidence. Apply [Task Pack Audit](../skills/task-pack-audit/SKILL.md) to the
   changed release units and record the semantic findings and remaining limits
   in the task or PR. CI is mechanical evidence, not this semantic approval.
6. Tag the repository as `vX.Y.Z`. The Release workflow reruns strict validation,
   behavior tests, and repository tests on Linux, Windows, and macOS before any
   release is created.
7. After the matrix passes, GitHub Actions rebuilds the archives from the tag,
   uploads them to a draft release, and publishes the release only after every
   asset upload succeeds. A rerun may resume a draft, but it refuses to replace
   assets in an already-public release.
8. Download the published assets, verify their hashes, and compare the release
   index with the tagged catalog.

The release contains no Task Master binary, Chrome, login state, task output,
checkpoints, screenshots, caches, evolution receipts, or local backups.

Each ZIP contains one root `archive-manifest.json` integrity envelope and one
Skill directory. The installer verifies the envelope, installs only the Skill
directory, and preserves that Skill's native manifests byte for byte.

The cataloged TikTok bundle is a separate complete release unit: its ZIP has
three sibling Skills, its own Node installer and native `manifest.json`.
Verify it with `python tools/tiktok_bundle.py verify --archive path/to/bundle.zip`,
then extract it and run `node install.mjs`. Do not pass that bundle to the
single-Skill installer. The matrix also validates an extracted ZIP, installs
to a fresh Unicode/space path, and rebuilds via only the installed tools.
Deterministic assets omit validation timestamp, runner path and local host
metadata; actual environment details remain in the linked CI run. Offline
CI is distinct from live browser or platform compatibility.
