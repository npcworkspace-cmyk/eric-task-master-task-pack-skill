# Pack completion audit

After creating or updating a Pack Skill or a task-driven evolution candidate,
and before delivery or publication, apply `skills/task-pack-audit/SKILL.md`.
Use its eight principles, inspect the actual implementation and relevant test
commands, and report evidence, concrete findings, minimal fixes and untested
scope. Audit the complete release unit, including declared shared dependencies.

Use judgment for applicability; do not force identical platform implementations
or repeat a full audit after an unchanged routine collection. Audit artifacts
belong outside release payloads. CI passing is mechanical evidence, not proof
of a completed semantic review. Recheck affected conclusions after fixes.

Keep changes within the user's task and current authorization. An audit does
not itself authorize browser collection, unrelated fixes, or publication.
