#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageSkill } from './package-skill.mjs';
import { deploySkill } from './deploy-skill.mjs';

async function withRoot(name, fn) {
  const root = await mkdtemp(path.join(tmpdir(), `reddit-skill-portable-${name}-`));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function fixture(root, body = 'one') {
  const skill = path.join(root, 'portable-fixture');
  await mkdir(path.join(skill, '资料 space'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), `---\nname: portable-fixture\ndescription: Fixture.\n---\n\n${body}\n`);
  await writeFile(path.join(skill, '资料 space', '数据.json'), `${JSON.stringify({ body })}\n`);
  return skill;
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
function storedEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'Fixture ZIP must use the portable stored method');
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.ok(entries.size > 0 && bytes.readUInt32LE(offset) === 0x02014b50, 'ZIP central directory was not found');
  return entries;
}

test('PORTABLE ZIP: deterministic archive preserves relative UTF-8 paths and bytes', async () => withRoot('zip', async root => {
  const skill = await fixture(root);
  const firstPath = path.join(root, 'first.zip');
  const secondPath = path.join(root, 'second.zip');
  const first = await packageSkill(skill, firstPath, { validateRelease: false });
  const second = await packageSkill(skill, secondPath, { validateRelease: false });
  assert.equal(first.sha256, second.sha256);
  const entries = storedEntries(await readFile(firstPath));
  assert.deepEqual([...entries.keys()].sort(), ['portable-fixture/SKILL.md', 'portable-fixture/资料 space/数据.json'].sort());
  assert.deepEqual(entries.get('portable-fixture/SKILL.md'), await readFile(path.join(skill, 'SKILL.md')));
}));

test('PORTABLE ZIP: existing destination is never overwritten', async () => withRoot('zip-existing', async root => {
  const skill = await fixture(root);
  const target = path.join(root, 'existing.zip');
  await writeFile(target, 'keep');
  await assert.rejects(packageSkill(skill, target, { validateRelease: false }), /already exists/);
  assert.equal(await readFile(target, 'utf8'), 'keep');
}));

test('PORTABLE ZIP: default packaging rejects a dirty release before creating an archive', async () => withRoot('zip-gate', async root => {
  const skill = await fixture(root);
  const fakeTask = ['task', '1234567890abcdef'].join('_');
  await writeFile(path.join(skill, 'run-note.md'), `${fakeTask}\n`);
  const target = path.join(root, 'blocked.zip');
  await assert.rejects(packageSkill(skill, target), /task_id/);
  await assert.rejects(lstat(target), error => error?.code === 'ENOENT');
}));

test('PORTABLE ZIP: a physical directory alias cannot place the archive inside its source', async () => withRoot('zip-alias', async root => {
  const skill = await fixture(path.join(root, 'source'));
  const alias = path.join(root, 'source-alias');
  if (!await directoryAlias(skill, alias)) return;
  const target = path.join(alias, 'inside.zip');
  await assert.rejects(packageSkill(skill, target, { validateRelease: false }), /outside the Skill source/);
  await assert.rejects(lstat(path.join(skill, 'inside.zip')), error => error?.code === 'ENOENT');
}));

test('PORTABLE ZIP: post-write failure removes only the archive opened by this call', async () => withRoot('zip-owned-cleanup', async root => {
  const skill = await fixture(root);
  const target = path.join(root, 'owned.zip');
  await assert.rejects(packageSkill(skill, target, {
    validateRelease: false,
    afterArchiveWritten: () => { throw new Error('intentional post-write failure'); },
  }), /intentional post-write failure/);
  await assert.rejects(lstat(target), error => error?.code === 'ENOENT');
}));

test('PORTABLE DEPLOY: install is verified and replacement keeps a rollback directory', async () => withRoot('deploy', async root => {
  const firstSource = await fixture(path.join(root, 'one'), 'one');
  const skillsRoot = path.join(root, 'skills root');
  const first = await deploySkill(firstSource, skillsRoot, { validateRelease: false });
  assert.equal(first.backup, null);
  const secondSource = await fixture(path.join(root, 'two'), 'two');
  const explicitBackupRoot = path.join(root, 'permanent backups');
  const second = await deploySkill(secondSource, skillsRoot, { validateRelease: false, backupRoot: explicitBackupRoot });
  assert.ok(second.backup);
  assert.equal(path.resolve(second.backup).startsWith(`${path.resolve(skillsRoot)}${path.sep}`), false);
  assert.equal(path.dirname(second.backup), path.resolve(explicitBackupRoot));
  assert.match(await readFile(path.join(second.installed, 'SKILL.md'), 'utf8'), /two/);
  assert.match(await readFile(path.join(second.backup, 'SKILL.md'), 'utf8'), /one/);
  assert.deepEqual(await readdir(skillsRoot), ['portable-fixture']);
}));

test('PORTABLE SOURCES: symlinks are rejected by package and deploy', async () => withRoot('symlink', async root => {
  const skill = await fixture(root);
  const external = path.join(root, 'external.txt');
  await writeFile(external, 'outside');
  try { await symlink(external, path.join(skill, 'linked.txt'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(packageSkill(skill, path.join(root, 'bad.zip'), { validateRelease: false }), /symlink/);
  await assert.rejects(deploySkill(skill, path.join(root, 'skills'), { validateRelease: false }), /symlink/);
}));

test('PORTABLE DEPLOY: a failed installed-inventory check restores the previous version', async () => withRoot('rollback', async root => {
  const firstSource = await fixture(path.join(root, 'one'), 'known-good');
  const secondSource = await fixture(path.join(root, 'two'), 'bad-candidate');
  const skillsRoot = path.join(root, 'skills');
  const first = await deploySkill(firstSource, skillsRoot, { validateRelease: false });
  await assert.rejects(deploySkill(secondSource, skillsRoot, {
    validateRelease: false,
    afterCandidateInstalled: installed => writeFile(path.join(installed, 'SKILL.md'), 'corrupted after rename')
  }), /inventory differs/);
  assert.match(await readFile(path.join(first.installed, 'SKILL.md'), 'utf8'), /known-good/);
  assert.deepEqual(await readdir(skillsRoot), ['portable-fixture']);
  const backupRoot = path.join(root, 'skills-backups');
  assert.ok((await readdir(backupRoot)).some(name => name.startsWith('portable-fixture.backup-')));
}));
