# Contributing

Each directory under `skills/` is an independent Codex Skill and release unit.
Keep platform routing, evidence semantics, recovery rules, and output contracts
inside the affected Skill. Shared repository tools may validate, package, and
install Skills, but a release ZIP must work after every other Skill and the
source repository have been removed.

## Development flow

1. Create a branch and change the smallest affected Skill or shared tool.
2. Keep task inputs and run artifacts outside `skills/`.
3. Add a behavior test for a demonstrated bug or new invariant.
4. Run `python tools/skillkit.py validate --all --strict`.
5. Run `python tools/skillkit.py test --all`.
6. Run `python -m unittest discover -s tests -p "test_*.py"`.
7. Build and verify release archives with
   `python tools/skillkit.py package --all --output dist`.

Changes to tests require review of the test diff as well as a passing run.
Removing an assertion to make a candidate pass is not an acceptable fix.

## Skill rules

- Keep the frontmatter `name` equal to the folder name.
- Keep the description precise enough for correct routing.
- Link conditional detail from `SKILL.md` into `references/`.
- Use `scripts/` only for repeatable deterministic work.
- Use synthetic examples. Label claims, observations, inferences, and unknowns.
- Do not infer that a visible page grants permission to collect or reuse data.
- Preserve checkpoints and partial results. Task completion and business
  completeness are separate states.
- Browser work must use Eric Task Master and an explicitly selected Profile
  when the user provides one.

## Versioning

Every Skill has an independent semantic version in `catalog.json`. Use a major
version for incompatible input, checkpoint, or completion semantics; a minor
version for compatible capabilities; and a patch version for compatible fixes
or documentation corrections. Repository tags use `vX.Y.Z`; release asset
filenames retain each Skill's own version.
