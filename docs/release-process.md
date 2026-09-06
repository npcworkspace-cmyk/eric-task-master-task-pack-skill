# Release process

1. Update the affected Skill version in `catalog.json` and `CHANGELOG.md`.
2. Run strict validation and all synthetic behavior tests.
3. Build deterministic archives with `tools/skillkit.py package`.
4. Install every archive into a fresh Unicode-and-space directory and validate
   the installed copy.
5. Review `release-index.json`, `SHA256SUMS`, maturity labels, and compatibility
   evidence.
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
