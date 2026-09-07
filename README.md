# Eric Task Master Skills

**Turn work you know how to do into work your AI agent can repeat at scale.**

English | [简体中文](README.zh-CN.md)

Find creators. Collect community discussions. Gather evidence for research. Give your agent a goal and a reusable Skill, then let [Eric Task Master](https://github.com/npcworkspace-cmyk/eric-task-master) run the browser work in batches while results are saved along the way.

This is the community Skill library for Task Master. A Skill contains **instructions the agent can follow, scripts that do the repetitive work, and checks that tell you what actually finished**. You can use an existing Skill, improve one, or publish your own.

Our goal is to make large-scale automation practical for individuals: one person should be able to organize work that would otherwise take hours of repeated clicking, and share that capability so the next person starts further ahead.

[Start using a Skill](#start-here) · [Agent quick start](docs/agent-quickstart.md) · [Contribute a Skill](CONTRIBUTING.md) · [Download Skills](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/releases/latest) · [Get Task Master](https://github.com/npcworkspace-cmyk/eric-task-master)

## What can I use today?

| I want to… | Give the agent… | Get back… | Skill |
| --- | --- | --- | --- |
| Collect Facebook group posts | Group links, a time range, and a collection budget | Posts, source links, field checks, JSON/CSV and optional XLSX, plus coverage gaps | [Facebook group posts](skills/facebook-group-posts/SKILL.md) |
| Read comments across known Reddit posts | Post links and a reading budget | Comments with reply relationships, saved progress, and a report of missing or inaccessible branches | [Reddit comments](skills/reddit-comment-fetch/SKILL.md) |
| Find and expand a TikTok creator shortlist | Target countries, follower range, 3–5 labeled references, creator category and style | Reference research, deduplicated candidates, screening evidence, and seeds for another expansion round | [TikTok discovery](bundles/tiktok-discovery/START-HERE.md) |
| Find and expand Instagram creators | The desired outcome, account/post references, any audience criteria, and discovery/review budgets | Traceable candidates, separate creator and intermediary reviews, expansion scopes, and an offline count/cost audit | [Instagram discovery](skills/instagram-creator-discovery/SKILL.md) |
| Check a completed Skill or Pack before sharing it | The complete source/bundle, intended behavior, and available test evidence | An evidence-based review, concrete fixes, untested scope, and an optional source snapshot | [Task Pack Audit](skills/task-pack-audit/SKILL.md) |

TikTok comes as three Skills in one ZIP: **research and find seeds → expand from reviewed seeds → review the run and improve the method**. Install them together; you can call each stage separately.

Instagram is one independent Skill with a Task Master collection entry and an offline audit tool. It covers reference research, batch discovery, review, and expansion from reviewed seeds; it does not require the TikTok bundle.

These are the currently published workflows. Ideas such as product research, supplier discovery, media monitoring, and website QA are welcome contributions, not capabilities already included in this library.

## Start here

### 1. Give your agent the project link and your task

Copy this message into an agent that can read local files and run terminal commands:

```text
Use the Skills in https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill
to help me complete this task: [describe the result I need].

Read README.md and docs/agent-quickstart.md. Choose and install the matching
published Skill. If Task Master or another dependency is missing, help me
set it up from its official release. Read the installed SKILL.md before running.

My inputs and limits: [links, scope, budget, and any chosen Chrome Profile].
Ask only for missing information. Start with a small batch, check its output,
then continue within my authorized scope. Give me the result files, what is
still missing, and the next useful step. Review the run before closing it.
```

For TikTok, label each reference as **competitor**, **brand partner**, or **style reference**. Add the target countries, follower range, and the kind of creator/content you want. The agent uses those references to build its search plan.

For Instagram, describe the content or partnership outcome and explain what each reference illustrates. Country and follower thresholds are task-specific criteria, not mandatory defaults. State whether the goal is discovered accounts, reviewed theme seeds, or qualified partners: the collector's discovery quota does not certify the latter two.

### 2. Set up your browser session

For browser workflows, install [Task Master](https://github.com/npcworkspace-cmyk/eric-task-master#install) and stable Google Chrome. In the Task Master Dashboard, choose a browser **Profile**—a separate saved browser session—and sign in where needed. Close its manual browser window before the automated task starts.

Task Master runs locally. Your agent needs access to that computer's files and terminal. Codex has a default Skill installation path; other agents can use their own Skill directory or read the installed `SKILL.md` directly. See the [installation commands and agent handoff](docs/agent-quickstart.md).

Task Pack Audit works on local files and does not need Task Master, Chrome, or a social account. Its optional snapshot tool needs Python 3.11+.

### 3. Check a small result, then expand

The agent should show you the task's Dashboard link and save useful results as it works. Start with a small batch to check the current website and your criteria. Then increase the batch budget or run another discovery round.

Speed depends on the website, your session, and how much checking the task needs. A thousand discovered accounts are not automatically a thousand qualified partners. Every delivery should say what was collected, what passed review, and what remains unknown.

## For agents: install, run, verify

Start with [docs/agent-quickstart.md](docs/agent-quickstart.md). It gives you:

1. The correct installer for a single Skill versus the TikTok three-Skill bundle.
2. The input requirements and execution entry for each workflow.
3. The Task Master commands for starting once, following progress, and preserving output.
4. The checks to perform before calling the business task complete.

Keep each task's links, credentials, Profile selection, budget, and output outside the reusable Skill. Use the user's chosen Profile. On login, verification, or access limits, preserve progress and hand control back through Task Master.

## Share a Skill. Make the next person's work easier.

Have you taught an agent to do a useful piece of work reliably? **We want that Skill here.** It can solve one narrow problem well. You do not need to build another automation platform.

- **Have an idea?** [Describe the workflow](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md): what you provide, what should happen, and what a good result looks like.
- **Have a working script?** [Package it as a Skill](CONTRIBUTING.md): add instructions, input/output examples, and a way to check the result.
- **Found something broken or confusing?** [Open an issue](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new) with a sanitized example. Fixes, translations, and clearer docs are useful contributions too.
- **Ready to share?** Fork the repository, open a pull request, and include your test evidence. After review and merge, a maintainer can publish it through the [release pipeline](docs/release-process.md).

AI agents can help write the docs, extract reusable code, add tests, and prepare a PR. Contributors remain responsible for checking what they submit. Remove client data, account details, and machine-specific settings before sharing.

As more people contribute, the library can cover more kinds of work. A fix discovered in one person's project can become a tested improvement everyone can use. **Use a Skill, improve it through real work, and contribute the useful part back.** That is how we want to grow this automation ecosystem.

## Improve with each run

The included Skills ask the agent to review successes, failures, wasted work, and missing evidence after a run. Useful improvements can update both instructions and scripts in an isolated candidate, pass validation, and become a new version with a rollback path.

A review can also conclude that no change is needed. A website error or a single unusual account should not silently rewrite everyone's workflow. See [how iteration works](docs/evolution.md).

Before sharing a new or changed Pack, use [Task Pack Audit](skills/task-pack-audit/SKILL.md) to check the actual implementation against the [eight authoring and iteration principles](skills/task-pack-audit/references/principles.md). It distinguishes confirmed issues, reasonable differences, and untested claims. A file snapshot only identifies what was reviewed; it does not judge the result for the agent.

## What has been tested?

Public CI runs offline tests and packaging checks on **Windows, macOS, and Linux**. The TikTok bundle also checks ZIP installation and rebuilding from the installed copy. CI does not log into social accounts, and passing it does not prove that every website or account is currently accessible.

The new Instagram modules have offline behavior and consistency tests. The next real task must first calibrate the current account's UI with a bounded batch; historical workflow observations are not live validation of the new modules. See [Instagram validation scope](skills/instagram-creator-discovery/references/validation-scope.md).

Published ZIPs include integrity metadata; each release includes `SHA256SUMS` and `release-index.json`. [View the CI](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/actions/workflows/ci.yml) or read the [release and verification process](docs/release-process.md).

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for platform names and trademarks.

---

**The two projects work together:**

- [Eric Task Master — install the local browser task runner](https://github.com/npcworkspace-cmyk/eric-task-master)
- [Task Master Skills — find, build, and share reusable workflows](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill)

Task Master keeps the browser work running. Skills teach your agent how to get a useful result.
