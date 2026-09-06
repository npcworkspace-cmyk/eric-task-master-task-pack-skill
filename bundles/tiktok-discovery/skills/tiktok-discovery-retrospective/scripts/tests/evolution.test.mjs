// Synthetic fixtures. No real customers, browsers or installed Skills are modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installSkills, restoreInstallation, SKILL_NAMES, sha256, verifyPackage } from '../deployment.mjs';
import { bootstrap, payload, structuralChecks, buildPackage, assertValidated, stage } from '../evolve.mjs';
import { createIndex, summarize, normalizeInput } from '../../../tiktok-seed-discovery/scripts/runtime/browser.mjs';
import { closeIteration } from '../retrospect.mjs';

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tk-evolution 空格-'));
  t.after(async () => { if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('tk-evolution 空格-')) throw Error('Unsafe test cleanup'); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function sourceAt(root) {
  const source = path.join(root, 'source');
  for (const name of SKILL_NAMES) {
    await fs.mkdir(path.join(source, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: Synthetic skill for deployment tests.\n---\n');
    await fs.writeFile(path.join(source, 'skills', name, 'executor.mjs'), 'export const version = 1;\n');
  }
  await bootstrap(source);
  await fs.writeFile(path.join(source, 'skills', SKILL_NAMES[2], 'release.json'), JSON.stringify({ schemaVersion: 1, version: '2.1.0', minimumNodeMajor: 22, skills: SKILL_NAMES }));
  return source;
}
test('missing business bounds stay unknown and legacy discovery requires explicit business targets', () => {
  const index = createIndex(); index.authors.set('synthetic', { handle: 'synthetic', followers: 6000 });
  assert.equal(summarize(index).followersInRange, null);
  assert.equal(summarize(index, { minFollowers: 5000, maxFollowers: 7000 }).followersInRange, 1);
  assert.throws(() => normalizeInput({ briefId: 'synthetic', queries: ['synthetic topic'] }), /targetWorks/);
  const input = normalizeInput({ briefId: 'synthetic', queries: ['synthetic topic'], targetWorks: 25, minFollowers: 0, maxFollowers: 500 });
  assert.equal(input.targetWorks, 25); assert.equal(input.minFollowers, 0);
});
test('deployment restores both MD and executor across all three Skills and preserves unrelated task files', async t => {
  const root = await temp(t), source = await sourceAt(root), target = path.join(root, 'installed');
  await installSkills({ sourceRoot: source, skillsDir: target });
  await fs.writeFile(path.join(root, 'task-state.json'), '{"status":"paused"}');
  for (const name of SKILL_NAMES) {
    await fs.appendFile(path.join(source, 'skills', name, 'SKILL.md'), 'Updated behavior.\n');
    await fs.writeFile(path.join(source, 'skills', name, 'executor.mjs'), 'export const version = 2;\n');
  }
  const newer = await installSkills({ sourceRoot: source, skillsDir: target });
  assert.equal(newer.backups.length, 3);
  const restored = await restoreInstallation({ skillsDir: target, installId: newer.installId });
  assert.equal(restored.status, 'restored_verified'); assert.equal(restored.restored.length, 3);
  for (const name of SKILL_NAMES) {
    assert.equal(await fs.readFile(path.join(target, name, 'executor.mjs'), 'utf8'), 'export const version = 1;\n');
    assert.ok(!(await fs.readFile(path.join(target, name, 'SKILL.md'), 'utf8')).includes('Updated'));
  }
  assert.equal(await fs.readFile(path.join(root, 'task-state.json'), 'utf8'), '{"status":"paused"}');
});
test('rollback refuses edited installed files before replacing any Skill', async t => {
  const root = await temp(t), source = await sourceAt(root), target = path.join(root, 'installed');
  const receipt = await installSkills({ sourceRoot: source, skillsDir: target });
  await fs.appendFile(path.join(target, SKILL_NAMES[1], 'SKILL.md'), 'Another edit');
  await assert.rejects(restoreInstallation({ skillsDir: target, installId: receipt.installId }), /INSTALLED_FILES_CHANGED/);
  assert.ok((await fs.readFile(path.join(target, SKILL_NAMES[1], 'SKILL.md'), 'utf8')).endsWith('Another edit'));
});

test('a failed third replacement restores the earlier two Skills instead of leaving mixed versions', async t => {
  const root = await temp(t), source = await sourceAt(root), target = path.join(root, 'installed');
  await installSkills({ sourceRoot: source, skillsDir: target });
  for (const name of SKILL_NAMES) await fs.writeFile(path.join(source, 'skills', name, 'executor.mjs'), 'export const version = 2;\n');
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.basename(from) === 'staged-' + SKILL_NAMES[2] && to === path.join(target, SKILL_NAMES[2])) throw Error('Synthetic filesystem replacement failure');
    return originalRename(from, to);
  };
  try { await assert.rejects(installSkills({ sourceRoot: source, skillsDir: target }), /Synthetic filesystem replacement failure/); }
  finally { fs.rename = originalRename; }
  for (const name of SKILL_NAMES) assert.equal(await fs.readFile(path.join(target, name, 'executor.mjs'), 'utf8'), 'export const version = 1;\n');
});
test('staging preserves installed files and refuses to package task JSON', async t => {
  const root = await temp(t), source = await sourceAt(root), installed = path.join(root, 'installed');
  await installSkills({ sourceRoot: source, skillsDir: installed });
  const staged = await stage({ skillsDir: installed, outDir: path.join(root, 'candidate') });
  assert.equal(staged.status, 'staged');
  await fs.appendFile(path.join(staged.candidate, 'skills', SKILL_NAMES[0], 'SKILL.md'), 'Candidate only');
  assert.ok(!(await fs.readFile(path.join(installed, SKILL_NAMES[0], 'SKILL.md'), 'utf8')).includes('Candidate'));
  await fs.writeFile(path.join(staged.candidate, 'skills', SKILL_NAMES[0], 'customer-brief.json'), '{}');
  await assert.rejects(payload(staged.candidate), /NON_PORTABLE_PAYLOAD_FILE/);
});
test('release refuses stale MD or executor bytes and archive manifest detects tampering', async t => {
  const root = await temp(t), source = await sourceAt(root), files = await payload(source), validation = path.join(root, 'validation.json');
  // This fabricated passing report exists only to exercise integrity gates on synthetic files.
  await fs.writeFile(validation, JSON.stringify({ status: 'passed', version: '2.1.0', payloadHash: sha256(JSON.stringify(files)), files, offlineTests: { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 } }));
  const release = await buildPackage({ sourceRoot: source, validationFile: validation, outDir: path.join(root, 'release') });
  await verifyPackage(release.packageDir);
  const md = path.join(source, 'skills', SKILL_NAMES[0], 'SKILL.md'), original = await fs.readFile(md);
  await fs.appendFile(md, 'Later edit');
  await assert.rejects(assertValidated(source, validation), /VALIDATION_STALE_OR_FAILED/);
  await fs.writeFile(md, original);
  await fs.appendFile(path.join(source, 'skills', SKILL_NAMES[0], 'executor.mjs'), 'export const changed = true;');
  await assert.rejects(assertValidated(source, validation), /VALIDATION_STALE_OR_FAILED/);
  await fs.appendFile(path.join(release.packageDir, 'skills', SKILL_NAMES[0], 'SKILL.md'), 'Corrupted');
  await assert.rejects(verifyPackage(release.packageDir), /PACKAGE_HASH_MISMATCH/);
  await assert.rejects(installSkills({ sourceRoot: release.packageDir, skillsDir: path.join(root, 'target'), requireManifest: true }), /PACKAGE_HASH_MISMATCH/);
});
test('missing local MD references are caught before runtime execution', async t => {
  const root = await temp(t), source = await sourceAt(root);
  await fs.appendFile(path.join(source, 'skills', SKILL_NAMES[0], 'SKILL.md'), '[guide](missing.md)\n');
  await assert.rejects(structuralChecks(source, await payload(source)), /MISSING_PACKAGED_REFERENCE/);
});

test('every retrospective requires MD and executor decisions and binds them to the actual report', async t => {
  const root = await temp(t), report = path.join(root, 'report.json'), input = path.join(root, 'iteration.json'), out = path.join(root, 'closed.json');
  await fs.writeFile(report, '{}');
  const decision = { schemaVersion: 1, reportFile: 'report.json', reportHash: sha256('{}'), md: { status: 'pending', reason: '', evidence: [] }, executor: { status: 'unchanged', reason: 'Synthetic failure belongs to platform access.', evidence: [] }, policy: { status: 'deferred', reason: 'No comparable live sample.', evidence: [] } };
  await fs.writeFile(input, JSON.stringify(decision));
  await assert.rejects(closeIteration(input, out), /Review md/);
  decision.md = { status: 'unchanged', reason: 'Current instructions describe the observed failure.', evidence: [] };
  await fs.writeFile(input, JSON.stringify(decision));
  assert.equal((await closeIteration(input, out)).status, 'closed');
  await fs.writeFile(report, '{"changed":true}');
  await assert.rejects(closeIteration(input, out), /report changed/);
});
