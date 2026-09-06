#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRelease as verifyPortableBundle } from './validate-release.mjs';
import { packageSkill } from './package-skill.mjs';
import { releaseSkill } from './release-skill.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
async function withRoot(name, fn) {
  const root = await mkdtemp(path.join(tmpdir(), `portable-bundle-${name}-`));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function directoryAlias(target, alias) {
  try {
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return false;
    throw error;
  }
}
async function goodSkill(root) {
  await mkdir(path.join(root, 'assets', 'pack'), { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Generic fixture.\n---\n\nUse the supplied input.\n');
  await writeFile(path.join(root, 'assets', 'pack', 'pack.json'), json({ name: 'fixture-pack', version: '1.0.0', runtime_capabilities: ['page.goto', 'outputDir'] }));
  await writeFile(path.join(root, 'validation.json'), json({ schemaVersion: 1, version: '1.0.0', checks: { offline: 'passed', platforms: { windows: 'tested', macos: 'not_tested', linux: 'not_tested' } } }));
}

async function files(root, directory = root, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await files(root, absolute, result);
    else if (entry.isFile() && path.relative(root, absolute) !== 'validation.json') result.push(absolute);
  }
  return result;
}

async function fullSkill(root) {
  const content = new Map([
    ['SKILL.md', '---\nname: portable-fixture\ndescription: Generic fixture.\nmetadata:\n  version: "1.0.0"\n---\n\nUse the supplied placeholder input.\n'],
    ['LICENSE', 'Fixture license for offline validation.\n'],
    ['THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nNo third-party material is bundled in this fixture.\n'],
    ['skill-release.json', json({
      schema: 1,
      name: 'portable-fixture',
      version: '1.0.0',
      platform: 'reddit',
      maturity: 'portable-offline-validated',
      taskmaster_contract: {
        binding: 'capability-based',
        required_capabilities: ['page.goto', 'response-body-read', 'writable-output-directory'],
        optional_capabilities: ['abort-signal', 'progress-callback', 'wait-callback'],
        version_pinned: false,
        adapter_rule: 'Resolve the local runtime contract during deployment.',
      },
      no_task_config: true,
      no_credentials: true,
      no_real_data: true,
    })],
    ['agents/openai.yaml', 'interface:\n  display_name: "Portable fixture"\n  short_description: "Offline release fixture"\n  default_prompt: "Use $portable-fixture with supplied input."\n'],
    ['assets/reddit-comment-tree-pack/collect.mjs', "export const note = 'run-retrospective.json'; export const policy = { autoMutationAllowed: false };\n"],
    ['assets/reddit-comment-tree-pack/input.example.json', json({ posts: ['REPLACE_WITH_POST_ID'] })],
    ['assets/reddit-comment-tree-pack/pack.json', json({ name: 'fixture-pack', version: '1.0.0', required_runtime_capabilities: { page: ['goto'], outputDir: 'writable path' } })],
    ['references/self-iteration.md', '# Self iteration\n\nUse a staged copy.\n'],
    ['schemas/run-review.schema.json', json({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' })],
    ['schemas/iteration-proposal.schema.json', json({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' })],
  ]);
  for (const name of [
    'verify-pack.mjs', 'verify-paused.mjs', 'verify-review.mjs', 'validate-release.mjs',
    'verify-release.mjs', 'package-skill.mjs', 'deploy-skill.mjs', 'verify-portability.mjs', 'release-skill.mjs',
  ]) content.set(`scripts/${name}`, name.startsWith('verify-') ? "const test = () => {};\ntest('fixture', () => {});\n" : 'export {};\n');
  for (const [relative, body] of content) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const records = [];
  for (const file of (await files(root)).sort((a, b) => lexical(path.relative(root, a), path.relative(root, b)))) {
    const bytes = await readFile(file);
    records.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const collectorSha256 = records.find(record => record.path === 'assets/reddit-comment-tree-pack/collect.mjs').sha256;
  await writeFile(path.join(root, 'validation.json'), json({
    schema: 1, bundleVersion: '1.0.0', releaseStatus: 'passed',
    checks: {
      coreBehavior: { status: 'passed', tests: 1, pass: 1, fail: 0 },
      pausedFinalization: { status: 'passed', tests: 1, pass: 1, fail: 0 },
      postRunReview: { status: 'passed', tests: 1, pass: 1, fail: 0 },
      releaseCleanliness: { status: 'passed', tests: 1, pass: 1, fail: 0 },
      portablePackageAndDeploy: { status: 'passed', tests: 1, pass: 1, fail: 0 },
    },
    artifacts: { collectorSha256, filesExcludingValidation: records },
  }));
  return root;
}

test('generic staged bundle passes', async () => withRoot('pass', async root => {
  await goodSkill(root);
  const result = await verifyPortableBundle(root, { full: false });
  assert.equal(result.status, 'passed');
  assert.equal(result.files, 3);
}));

test('full gate verifies a bidirectional byte and SHA-256 inventory', async () => withRoot('full-pass', async root => {
  await fullSkill(root);
  const result = await verifyPortableBundle(root);
  assert.equal(result.validationInventoryChecked, true);
}));

test('full gate rejects mismatched release identity and file hashes in release metadata', async () => withRoot('release-metadata', async root => {
  await fullSkill(root);
  const releasePath = path.join(root, 'skill-release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.name = 'different-skill';
  await writeFile(releasePath, json(release));
  await assert.rejects(() => verifyPortableBundle(root), /names differ/);

  await fullSkill(root);
  const withHash = JSON.parse(await readFile(releasePath, 'utf8'));
  withHash.file_sha256 = '0'.repeat(64);
  await writeFile(releasePath, json(withHash));
  await assert.rejects(() => verifyPortableBundle(root), /missing or unsupported fields|must not contain file hashes/);
}));

test('full gate rejects a file changed after validation was built', async () => withRoot('tamper', async root => {
  await fullSkill(root);
  await writeFile(path.join(root, 'SKILL.md'), '\nchanged after validation\n', { flag: 'a' });
  await assert.rejects(() => verifyPortableBundle(root), /byte count differs|SHA-256 differs/);
}));

test('full gate rejects files omitted from or left stale in validation', async () => withRoot('inventory', async root => {
  await fullSkill(root);
  await writeFile(path.join(root, 'unlisted.md'), 'generic\n');
  await assert.rejects(() => verifyPortableBundle(root), /inventory count differs|omits file/);
  await rm(path.join(root, 'unlisted.md'));
  const validationPath = path.join(root, 'validation.json');
  const validation = JSON.parse(await readFile(validationPath, 'utf8'));
  validation.artifacts.filesExcludingValidation.push({ path: 'missing.md', bytes: 1, sha256: '0'.repeat(64) });
  await writeFile(validationPath, json(validation));
  await assert.rejects(() => verifyPortableBundle(root), /inventory count differs|does not exist/);
}));

test('full gate rejects a collectorSha256 that differs from the inventoried collector', async () => withRoot('collector-sha', async root => {
  await fullSkill(root);
  const validationPath = path.join(root, 'validation.json');
  const validation = JSON.parse(await readFile(validationPath, 'utf8'));
  validation.artifacts.collectorSha256 = 'f'.repeat(64);
  await writeFile(validationPath, json(validation));
  await assert.rejects(() => verifyPortableBundle(root), /collectorSha256 differs/);
}));

test('concrete Task ID and machine path are rejected', async () => withRoot('content', async root => {
  await goodSkill(root);
  const fakeTask = ['task', '1234567890abcdef'].join('_');
  const fakePath = ['C:', 'Users', 'someone', 'run'].join('\\');
  await writeFile(path.join(root, 'notes.md'), `${fakeTask} lived at ${fakePath}\n`);
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /task_id|windows_absolute_path/);
}));

test('task-specific validation fields are rejected', async () => withRoot('validation', async root => {
  await goodSkill(root);
  await writeFile(path.join(root, 'validation.json'), json({ schemaVersion: 1, liveRedditCollection: { profile: 'example' } }));
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /Task-specific JSON field/);
}));

test('task-specific fields are rejected in every JSON file', async () => withRoot('all-json', async root => {
  await goodSkill(root);
  await writeFile(path.join(root, 'run-details.json'), json({ nested: { profile_name: 'named session' } }));
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /Task-specific JSON field/);
}));

test('input.example contains placeholders only', async () => withRoot('input-example', async root => {
  await goodSkill(root);
  const example = path.join(root, 'assets', 'pack', 'input.example.json');
  await writeFile(example, json({ posts: ['abc123'], maxRequests: 300 }));
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /Concrete posts array|posts placeholder|concrete or invalid post/);
}));

test('arbitrary drive and UNC paths are rejected', async () => withRoot('all-windows-paths', async root => {
  await goodSkill(root);
  const drive = ['Q:', 'custom', 'folder'].join('\\');
  const unc = ['', '', 'server-name', 'share-name', 'file'].join('\\');
  await writeFile(path.join(root, 'paths.md'), `${drive}\n${unc}\n`);
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /windows_drive_absolute_path|windows_unc_path/);
}));

test('HTTPS source URLs are not mistaken for Windows drive or UNC paths', async () => withRoot('https-paths', async root => {
  await goodSkill(root);
  await writeFile(path.join(root, 'sources.json'), json({
    api: 'https://www.reddit.com/dev/api/',
    schema: 'https://json-schema.org/draft/2020-12/schema',
  }));
  const result = await verifyPortableBundle(root, { full: false });
  assert.equal(result.status, 'passed');
}));

test('version-bound Pack metadata is rejected', async () => withRoot('pack', async root => {
  await goodSkill(root);
  await writeFile(path.join(root, 'assets', 'pack', 'pack.json'), json({ name: 'fixture', runtime_reference: 'one machine', tested_scope: 'one run' }));
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /runtime_reference|live-run evidence/);
}));

test('a fixed Task Master version in prose is rejected', async () => withRoot('runtime-version', async root => {
  await goodSkill(root);
  await writeFile(path.join(root, 'runtime.md'), ['Task', 'Master', ['9', '8', '7'].join('.')].join(' '));
  await assert.rejects(() => verifyPortableBundle(root, { full: false }), /fixed_task_master_version/);
}));

test('package defaults to the full gate and writes nothing after tampering', async () => withRoot('package-gate', async root => {
  const skill = path.join(root, 'portable-fixture');
  await mkdir(skill);
  await fullSkill(skill);
  await writeFile(path.join(skill, 'SKILL.md'), '\ntampered\n', { flag: 'a' });
  const target = path.join(root, 'blocked.zip');
  await assert.rejects(() => packageSkill(skill, target), /byte count differs|SHA-256 differs/);
  await assert.rejects(() => lstat(target), error => error?.code === 'ENOENT');
}));

test('release rejects a ZIP sidecar inside the Skill source before running suites', async () => withRoot('release-sidecar', async root => {
  const skill = path.join(root, 'portable-fixture');
  await mkdir(skill);
  await fullSkill(skill);
  await assert.rejects(
    () => releaseSkill(skill, path.join(root, 'outside.zip'), path.join(skill, 'inside.sha256.txt')),
    /sidecar destination must be outside/,
  );
  await assert.rejects(() => lstat(path.join(root, 'outside.zip')), error => error?.code === 'ENOENT');
}));

test('release rejects a sidecar that reaches the Skill source through a physical directory alias', async () => withRoot('release-sidecar-alias', async root => {
  const skill = path.join(root, 'skill');
  await fullSkill(skill);
  const alias = path.join(root, 'skill-alias');
  if (!await directoryAlias(skill, alias)) return;
  const archive = path.join(root, 'release.zip');
  await assert.rejects(releaseSkill(skill, archive, path.join(alias, 'inside.sha256.txt')), /outside the Skill source/);
  await assert.rejects(lstat(archive), error => error?.code === 'ENOENT');
  await assert.rejects(lstat(path.join(skill, 'inside.sha256.txt')), error => error?.code === 'ENOENT');
}));

test('release failure preserves same-name files that its suite created externally', async () => withRoot('release-owned-cleanup', async root => {
  const skill = path.join(root, 'skill');
  await fullSkill(skill);
  const archive = path.join(root, 'external.zip');
  const sidecar = path.join(root, 'external.sha256.txt');
  const priorValidation = await readFile(path.join(skill, 'validation.json'));
  const failingSuite = [
    'import { writeFile } from \'node:fs/promises\';',
    `await writeFile(${JSON.stringify(archive)}, 'external archive', { flag: 'wx' });`,
    `await writeFile(${JSON.stringify(sidecar)}, 'external sidecar', { flag: 'wx' });`,
    "throw new Error('intentional suite failure');",
    '',
  ].join('\n');
  await writeFile(path.join(skill, 'scripts', 'verify-pack.mjs'), failingSuite);
  await assert.rejects(releaseSkill(skill, archive, sidecar), /Release suite failed: coreBehavior/);
  assert.equal(await readFile(archive, 'utf8'), 'external archive');
  assert.equal(await readFile(sidecar, 'utf8'), 'external sidecar');
  assert.deepEqual(await readFile(path.join(skill, 'validation.json')), priorValidation);
}));

test('symlinks are rejected', async () => withRoot('symlink', async root => {
  await goodSkill(root);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  await writeFile(outside, 'outside');
  try { await symlink(outside, path.join(root, 'linked.txt'), 'file'); }
  catch (error) {
    await rm(outside, { force: true });
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  try { await assert.rejects(() => verifyPortableBundle(root, { full: false }), /Symlinks are not allowed/); }
  finally { await rm(outside, { force: true }); }
}));
