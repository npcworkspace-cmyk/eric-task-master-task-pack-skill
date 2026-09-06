# Task-local evolution protocol

Every completed, stopped, paused, uncertain, or review-required run leaves a
task-local evolution obligation. The run writes
`evolution-review-status.json` with a terminal fingerprint and `pending` state.
This file belongs to the task workspace, not the installed Skill.

## Review

The reviewer separates platform access failures, extractor defects, evidence
gaps, qualification uncertainty, and route performance. A single example is
not enough to create a universal rule. A proposed change records its evidence,
scope, expected benefit, rollback, and the invariant a behavior test will
exercise.

A review can close as:

- `no_change`: the evidence does not justify a reusable change;
- `candidate`: create an isolated candidate that may update scripts,
  `SKILL.md`, references, tests, and release metadata;
- `needs_more_evidence`: retain the gap without changing the release.

Closing the review writes an immutable receipt and changes the task marker to
`completed`. It never rewrites historical task evidence.

## Promotion

A candidate is promoted only after:

1. the original source tree is unchanged;
2. task-specific values and secrets are absent;
3. existing tests pass against the original baseline;
4. all candidate tests and portability gates pass;
5. changed tests receive an independent semantic review;
6. an isolated release ZIP installs and validates without another Skill;
7. the target is replaced atomically and the previous version is retained.

Repository publication uses a normal branch and pull request. Task output or
untrusted page content cannot directly modify an installed Skill, repository,
or release.
