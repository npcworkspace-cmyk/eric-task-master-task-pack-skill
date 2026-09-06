# Task Master contract

`taskmaster-task-module-v1` is the boundary between Eric Task Master and a
platform Skill. Task Master owns the browser and durable task lifecycle. The
module owns the work performed inside that lifecycle.

## Runtime input

A task entry exports:

```js
export async function run({ page, context, input, outputDir, progress, wait, signal }) {
  // bounded platform work
}
```

- `page` and `context` are Playwright browser objects owned by Task Master.
- `input` is the task-specific configuration. It is never baked into a Skill.
- `outputDir` is the only default destination for task artifacts.
- `progress()` reports meaningful durable units without secrets.
- `wait()` hands verification or another manual condition to the user.
- `signal` is checked before dispatching more work and before costly writes.

Only the entry `.mjs` is frozen by a normal Task Master run. A release must
therefore use one self-contained entry, an explicit build artifact, Node
built-ins, or bare `playwright`. It must not depend on an adjacent Skill or a
relative source-repository path.

## Ownership

Task Master owns Manager startup, Profile leases, browser processes, task ID,
heartbeat, waiting, resume, stop, persistence, progress transport, and process
cleanup. A Skill owns target validation, bounded action queues, platform
navigation, pagination, response parsing, checkpoints, deduplication, evidence,
coverage, review, export, and business completion.

## Profiles and verification

Use the Profile named by the user. Do not silently substitute another Profile.
If no Profile was named, follow the installed Task Master behavior. Never copy
Profile state into a task artifact or release.

When the module detects a verification page, stop new work and call `wait()`.
Resume only through Task Master's recorded handoff. Rate limiting, access
denial, or uncertain writes stop conservatively; a Skill does not rotate
accounts or routes to evade a control.

## Evidence levels

Release compatibility records distinguish:

- `static`: source and manifest checks;
- `offline`: synthetic executor and recovery tests;
- `taskmaster_smoke`: local CLI and fake-page lifecycle checks;
- `real_chrome`: authorized local Chrome behavior;
- `real_platform`: bounded authorized platform observation.

Passing a lower level never implies a higher level.
