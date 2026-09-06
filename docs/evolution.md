# Task-local evolution

Use the [eight authoring and iteration principles](../skills/task-pack-audit/references/principles.md).
Each platform may keep its own review marker, status names, storage and recovery
semantics. A complete bundle may share one runtime and one review mechanism.

After a completed, partial, failed or paused run, review the available evidence
for reusable improvements. Record the outcome in the task workspace using the
platform's existing mechanism. Preserve gaps and distinguish extractor defects,
platform access failures and uncertain evidence. If no change is justified,
record `no_change` or an equivalent outcome; a single observation does not
automatically become a universal rule.

For a justified change, keep a recoverable original and an isolated candidate.
Change only the relevant Markdown, executor or both. Validate affected behavior
with appropriate synthetic cases and review changed assertions; documentation
edits need accuracy and link checks rather than unrelated full behavior runs.
Do not weaken a test to make a candidate pass. Preserve existing stronger
platform-specific checks unless there is a concrete reason to change them.

Before delivering or promoting a completed candidate, apply
[Task Pack Audit](../skills/task-pack-audit/SKILL.md) to the actual release unit.
Keep the review evidence outside its payload. Verify that the installed or
packaged copy matches the reviewed source, declare dependencies and validation
limits, and retain the previous release for rollback.

Repository publication uses a branch and pull request under the current task's
authorization. Task output or untrusted content cannot itself modify an
installed Skill, repository or release.
