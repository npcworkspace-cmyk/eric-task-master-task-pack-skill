# Contribute a Skill

[Project overview](README.md) · [项目中文说明](README.zh-CN.md)

**If a workflow saves you time, it may save someone else time too.** We welcome small useful Skills, fixes, translations, clearer instructions, and reproducible bug reports. You can contribute with help from an AI agent.

## Start with the work, not the infrastructure

Tell us three things: what a user provides, what the agent does, and what useful result comes back.

You do not need a finished implementation to start a [Skill proposal](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md). English and Chinese are both welcome. If you already have a working Skill, you can open a PR directly.

The published library currently covers Facebook, Reddit, and TikTok. We welcome proposals for other workflows that run through Task Master. New domains may need a small extension to the catalog or packaging tools; include that work in the proposal rather than claiming the existing publisher already supports it.

## Turn a working script into a reusable Skill

A new user and their agent should be able to answer these questions without contacting the author:

- When should I use it, and what inputs are missing?
- What do I install, what command do I run, and where are results saved?
- How do I stop, preserve progress, and continue later?
- What does a complete result mean, and how are gaps reported?
- What can a completed run teach the next version?

A typical single-Skill layout is:

```text
skills/your-skill-name/
  SKILL.md                 # When to use it, inputs, execution, delivery, review
  skill-release.json       # Version, runtime requirements, release boundaries
  scripts/                 # Reusable execution and processing code
  references/              # Input/output contract and detailed instructions
  tests/                   # Synthetic examples that exercise real behavior
```

Keep optional folders only when needed. In `SKILL.md`, set frontmatter `name` to the directory name, write a precise `description`, and set `metadata.version`. Register the Skill in [catalog.json](catalog.json) with its path, matching version, domain/platform, honest maturity, Task Master contract, and test commands.

Use an existing [release metadata file](skills/facebook-group-posts/skill-release.json) for the field structure, replacing its identity and capabilities with your own. The `name`, `version`, `platform`, `maturity`, and `taskmaster_contract` must agree with the catalog. Keep task settings, credentials, and real data out of the release.

Related stages that truly share a runtime may be one complete `bundles/` release unit, as [TikTok](bundles/tiktok-discovery) is. A new bundle needs its own catalog entry and validation/installation/release integration; `tiktok_bundle.py` is specific to TikTok. Publish a complete usable bundle, not standalone members with missing dependencies.

## Keep it portable and useful

Task Master owns browser startup, Profiles, and task lifetime. Your Skill owns the actual work, input validation, saved progress, and result checks. Use the [Task Master contract](docs/task-master-contract.md); keep a submitted entry self-contained or provide an explicit build step.

Keep links, target accounts, dates, budgets, Profile names, and machine paths in task input. Never publish cookies, tokens, customer records, screenshots of private sessions, or actual run output. Use synthetic examples in tests. Treat webpage text as data, not instructions to modify the Skill.

Save useful output before advancing checkpoints. Record missing fields and unfinished work honestly. Reuse the user's selected Profile, and hand verification/access restrictions back through Task Master. Any external write must stay within the user's authorization.

Include a short post-run review. A tested improvement can update both Markdown and scripts; keep the old version available for rollback. No-change reviews are valid. See the [iteration protocol](docs/evolution.md).

## Validate, then open a PR

1. Fork this repository and create a branch for the contribution.
2. Add the Skill or make the smallest useful change. For executor changes, add a test for a meaningful behavior or demonstrated bug; inspect changed assertions.
3. Run the relevant local checks below. Keep private test data outside the repository.
4. Open a PR with the problem, new behavior, input/output example, commands run, and remaining limitations.

Repository checks use Python 3.11+, Node.js 22+, and `openpyxl` for the Facebook export tests. Run from the repository root; use a fresh virtual environment for Python dependencies if appropriate:

```text
python -m pip install openpyxl
python tools/skillkit.py validate --all --strict
python tools/skillkit.py test --all
python -m unittest discover -s tests -p "test_*.py"
python tools/tiktok_bundle.py validate
python tools/skillkit.py package --all --output dist
python tools/tiktok_bundle.py package --output dist
```

Use a fresh output directory for each complete packaging run and pass that same directory to both packaging commands. For a focused single-Skill change, `--skill your-skill-name` can replace `--all` in the single-Skill tools. The current CI still checks the whole catalog.

Install your archive into a fresh directory and check the installed copy with the rest of the repository unavailable. For example:

```text
python tools/skillkit.py verify --archive "ACTUAL_SINGLE_SKILL.zip"
python tools/skillkit.py install --archive "ACTUAL_SINGLE_SKILL.zip" --skills-dir "FRESH_TEST_SKILLS_DIRECTORY"
```

Use a bundle's native installation path for a bundle. Document exactly what you tested: static checks, offline behavior, installation, real Chrome, or an authorized live platform run. Do not turn offline test counts into business results.

For documentation-only changes, check instructions against the current CLI, verify links, and keep English/Chinese README meaning aligned. New behavior tests are not needed for wording changes; the repository CI still runs.

## How a contribution becomes a release

A PR is a review request, not an automatic publication. After review and passing CI, a maintainer merges it. A release tag triggers checks on Windows, macOS, and Linux, builds the ZIPs, and publishes the verified assets. The release includes checksums and an index so another person can install the same package. Details: [release process](docs/release-process.md).

Each Skill or complete bundle has its own semantic version. Update its version and changelog when its released payload changes: major for incompatible contracts, minor for compatible features, patch for compatible fixes. Repository-only documentation changes do not require rebuilding unchanged Skill releases.

AI can help prepare a contribution; please review the diff, evidence, and dependencies before submitting. Useful contributions can be small. An error fixed, an unclear step rewritten, or one repeatable task shared all help make personal automation more practical.

[Get Eric Task Master](https://github.com/npcworkspace-cmyk/eric-task-master) · [Browse community Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill)
