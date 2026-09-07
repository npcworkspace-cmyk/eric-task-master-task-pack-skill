# Agent quick start

[Project overview](../README.md) · [项目中文说明](../README.zh-CN.md)

Use this guide to select, install, and start an existing Skill. Read the chosen installed `SKILL.md` for its exact input schema and workflow; do not invent a universal input object for all platforms.

## 1. Select the workflow and collect only missing inputs

| Request | Install | Required task information | Read next |
| --- | --- | --- | --- |
| Facebook group posts | `facebook-group-posts` | Group URL(s), explicit time window/timezone, stopping condition and batch budget | [Skill](../skills/facebook-group-posts/SKILL.md) and [Pack contract](../skills/facebook-group-posts/references/pack-contract.md) |
| Comments from known Reddit posts | `reddit-comment-fetch` | Post URL(s)/ID(s), request budget, any skip/resume instructions | [Skill](../skills/reddit-comment-fetch/SKILL.md) and [input contract](../skills/reddit-comment-fetch/references/data-contract.md) |
| New TikTok creator search | Complete TikTok three-Skill bundle | Target countries, follower minimum/maximum, 3–5 references labeled competitor/brand partner/style reference, category and content style | [Start here](../bundles/tiktok-discovery/START-HERE.md), then [runtime contract](../bundles/tiktok-discovery/skills/tiktok-seed-discovery/scripts/runtime/CONTRACT.md) |
| Expand an existing TikTok seed pool | Same complete bundle | Reviewed seeds with evidence/provenance, the existing brief, round/quantity budget and stopping rules | [Expansion Skill](../bundles/tiktok-discovery/skills/tiktok-seed-expansion/SKILL.md) |
| Find, review, or expand Instagram creators | `instagram-creator-discovery` | Desired outcome, references or reviewed seeds, existing criteria, separate discovery/review targets and budgets | [Skill](../skills/instagram-creator-discovery/SKILL.md), [runtime contract](../skills/instagram-creator-discovery/references/runtime.md), and [validation scope](../skills/instagram-creator-discovery/references/validation-scope.md) |
| Find, review, or expand YouTube creators | `youtube-creator-discovery` | Channel/video references or reviewed seeds, topic/format criteria, distinct discovery/review scope and finite budgets | [Skill](../skills/youtube-creator-discovery/SKILL.md), [Pack contract](../skills/youtube-creator-discovery/references/pack-contract.md), and [validation scope](../skills/youtube-creator-discovery/references/validation-scope.md) |
| Audit a completed Skill or Pack | `task-pack-audit` | Complete release unit, intended behavior, relevant changes and test evidence | [Audit Skill](../skills/task-pack-audit/SKILL.md) and [principles](../skills/task-pack-audit/references/principles.md) |

Preserve inputs, authorization, Profile selection, pauses, and cooldowns already stated in the conversation. Ask for missing information together. If no published Skill fits, describe the gap and offer a [Skill proposal](../CONTRIBUTING.md); do not claim that an unlisted workflow is implemented.

## 2. Locate the local runtime

For browser collection, you need a local agent with file and terminal access, stable Chrome, and [Eric Task Master](https://github.com/npcworkspace-cmyk/eric-task-master). Use its installed Skill or current CLI help to locate the launcher and confirm the run/follow contract. A normal run starts Manager automatically; no task registration is required. Task Pack Audit reads local files; it does not require Task Master, Chrome, Node, or a social account. Its optional snapshot tool uses Python 3.11+.

If Task Master is missing, follow its [official installation guide](https://github.com/npcworkspace-cmyk/eric-task-master#install) and [latest release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest). Select the OS/CPU asset that actually exists and verify its checksum. The Manager bundle includes Node and Playwright; use the bundled Node's actual path if it is not on PATH. Chrome and site login are provided by the local computer.

Installing through the repository tools needs Git and **Python 3.11+**. **Node.js 22+** is the tested common baseline for the browser collection scripts. Facebook XLSX export additionally uses `openpyxl`; install that dependency when XLSX is needed. The standalone TikTok ZIP's installer uses Node built-ins and does not need this repository or Python. The optional download command below uses GitHub CLI (`gh`).

## 3. Install only the selected release unit

Keep downloads and installation destinations separate from task input/output. Quote paths for the current shell.

### Facebook, Reddit, Instagram, YouTube, or Task Pack Audit

From a local working directory:

```text
git clone https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill.git
cd eric-task-master-task-pack-skill
python tools/skillkit.py install --skill facebook-group-posts
```

For Reddit, use `--skill reddit-comment-fetch`; for Instagram, use `--skill instagram-creator-discovery`; for YouTube, use `--skill youtube-creator-discovery`; for a local audit, use `--skill task-pack-audit`. This route installs the checked-out source. For a published release, download that Skill's ZIP from [Releases](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/releases/latest) and use:

```text
python tools/skillkit.py verify --archive "PATH_TO_DOWNLOADED_SKILL.zip"
python tools/skillkit.py install --archive "PATH_TO_DOWNLOADED_SKILL.zip"
```

Resolve the placeholder to the real downloaded file. The installer reports the actual target directory. Default directory order: explicit `--skills-dir`, `SOCIAL_SKILLS_DIR`, `CODEX_HOME/skills`, then `~/.codex/skills`. For another agent, pass `--skills-dir "ACTUAL_AGENT_SKILLS_DIRECTORY"`.

An existing installation is preserved unless `--replace` is supplied. For an authorized update, inspect local changes, then use `--replace`; the installer retains a backup.

### TikTok: install all three Skills together

Use the published ZIP, which contains `install.mjs`, `manifest.json`, and three sibling Skill directories. The source bundle in a Git checkout is not a ready-to-install release and intentionally lacks the generated manifest.

The following commands reproduce the published **repository release v0.3.0 / TikTok bundle v2.1.1**. For a later release, read its `release-index.json` and substitute its actual tag and ZIP name. Run from the repository root after cloning as above:

```text
gh release download v0.3.0 --repo npcworkspace-cmyk/eric-task-master-task-pack-skill --pattern "tiktok-discovery-three-skills-v2.1.1.zip" --pattern "SHA256SUMS" --pattern "release-index.json" --dir downloads
python tools/tiktok_bundle.py verify --archive downloads/tiktok-discovery-three-skills-v2.1.1.zip
python -m zipfile -e downloads/tiktok-discovery-three-skills-v2.1.1.zip downloads/tiktok-v2.1.1
node downloads/tiktok-v2.1.1/install.mjs --dry-run
node downloads/tiktok-v2.1.1/install.mjs
```

Use a fresh download/extraction directory if these already exist. Without `gh`, download the same files from the [release page](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/releases/tag/v0.3.0). Compare the ZIP hash with `SHA256SUMS` and its `release-index.json` record. The native verifier and installer also check archive/file integrity.

The native installer defaults to `CODEX_HOME/skills` or `~/.codex/skills`; it does not use `SOCIAL_SKILLS_DIR`. Add `--skills-dir "ACTUAL_AGENT_SKILLS_DIRECTORY"` for another host. It verifies the complete package and backs up changed installed Skills. Do not pass the TikTok bundle to `skillkit.py install`.

After installation, reload Skills using the host agent's mechanism, or explicitly read the installed files. Do not assume every agent automatically discovers Codex's directory.

## 4. Prepare the first task from the installed Skill

Use the actual installed root returned by the installer. Save task configuration and results in a separate working directory.

For **Task Pack Audit**, read its installed `SKILL.md`, inspect the complete target and relevant evidence, and write the review outside the target. Use `scripts/snapshot.py` only if a source identity snapshot is useful. Skip all browser startup commands below; a snapshot is not a semantic pass/fail review.

- **Facebook:** read `SKILL.md`, then run `node scripts/prepare.mjs --help` from that Skill's directory. Prepare the task with the user's group/time window and budget. Use the returned config with `node scripts/batches.mjs run --config "ACTUAL_CONFIG_JSON"`; this supervisor submits the browser batches through Task Master.
- **Reddit:** read `SKILL.md`, `references/data-contract.md`, and `references/runtime-adaptation.md`. Copy `assets/reddit-comment-tree-pack/` to the task directory; its browser entry is `collect.mjs`. Fill `input.example.json` with the user's task, then run `node scripts/verify-pack.mjs "ABSOLUTE_COPIED_COLLECT.mjs"` from the installed Skill directory. Submit that copied entry through Task Master.
- **TikTok:** from the installed `tiktok-seed-discovery` directory, run `node scripts/doctor.mjs`. Follow `scripts/runtime/CONTRACT.md`: `intake.mjs` prepares the task; `reference-browser.mjs` collects references through Task Master; `reference-analysis.mjs` prepares material for Agent review; `browser.mjs` runs search/enrichment batches through Task Master. The offline `process.mjs` handles centralized processing. These files are under `scripts/runtime/`. Existing reviewed seeds enter the expansion Skill; do not submit offline processing scripts as browser tasks.
- **Instagram:** read `SKILL.md` and `references/runtime.md`. Put the brief, frozen baseline, finite actions, budgets, and output paths in the task directory, then submit the self-contained `scripts/collect.mjs` through Task Master. Run `node scripts/ig-audit.mjs --help` locally for offline reconciliation; do not submit the audit tool as a browser task. The new modules have offline validation only, so start the next real task with bounded UI calibration. Use country/follower criteria only when the task calls for them. `targetCount` is the net-new discovery quota; reviewed theme seeds or qualified partners need their own business goal and evidence checks.
- **YouTube:** read `SKILL.md` and `references/pack-contract.md`. Save the brief, baseline, finite browser actions and review scope outside the Skill. Submit `scripts/browser.mjs` through Task Master; run `node scripts/process.mjs "ABSOLUTE_PROCESS_CONFIG.json"` locally for deduplication, author-resolution queues and review reconciliation. The processor imports evidence-based Agent decisions; it does not perform semantic qualification. Calibrate the current UI with a bounded batch before expanding.

Use the installed Task Master launcher. Replace the placeholders with real paths and returned values; the following is the common CLI lifecycle, not a replacement for a Skill's supervisor:

```text
taskmaster run "ABSOLUTE_ENTRY.mjs" --input "@ABSOLUTE_INPUT.json" --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 30000 --json
taskmaster follow TASK_ID --after SEQUENCE --wait-ms 30000 --json
```

If the user chose a Profile, include `--profile "NAME_OR_ID"` on every run. Otherwise use the configured default. If Task Master returns `DEFAULT_PROFILE_REQUIRED`, open the panel and ask the user to select one. For manual sign-in, open that Profile in the panel, let the user sign in, and close its manual windows before starting the task.

Keep the task ID and returned `outputDir`. Immediately share the Dashboard URL. Continue using the `after` cursor from `follow`; do not repeatedly submit `run` to poll progress.

Only the entry `.mjs` is frozen into a normal Task Master task. Use the Skill's self-contained entry or documented task copy; relative sibling imports are not automatically copied. See the [runtime contract](task-master-contract.md).

## 5. Deliver evidence, then review

Start with a small batch for a new target or page structure, inspect its output, and continue within the user's existing scope and budget. Do not stop for another approval at every stage when the work is already authorized.

A useful delivery includes result files, actual counts, applied filters, coverage/unknowns, the output directory, and a resume path if unfinished. Read the artifacts: an exit code of zero is not proof that all requested data was found or every candidate qualified.

On a verification page or access restriction, preserve the checkpoint and follow the installed Task Master's wait/stop handoff. Preserve user-requested pauses. Do not rotate accounts or Profiles to evade the restriction.

Finally run the chosen Skill's retrospective. Keep run-specific findings in the task directory. Promote only tested reusable improvements through the [iteration process](evolution.md); publishing a contribution follows the [contribution guide](../CONTRIBUTING.md).
