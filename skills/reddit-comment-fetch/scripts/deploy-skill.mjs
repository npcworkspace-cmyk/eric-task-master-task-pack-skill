#!/usr/bin/env node
/** Cross-platform directory deployment with inventory verification and rollback retention. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './validate-release.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function inventory(root, directory = root, result = {}) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    check(!info.isSymbolicLink(), `Skill contains a symlink: ${path.relative(root, absolute)}`);
    if (info.isDirectory()) await inventory(root, absolute, result);
    else if (info.isFile()) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const bytes = await readFile(absolute);
      result[relative] = { bytes: bytes.length, sha256: hash(bytes) };
    } else throw new Error(`Unsupported Skill entry: ${path.relative(root, absolute)}`);
  }
  return result;
}
async function copyTree(source, destination) {
  await mkdir(destination);
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    check(!info.isSymbolicLink(), `Skill contains a symlink: ${entry.name}`);
    if (info.isDirectory()) await copyTree(from, to);
    else if (info.isFile()) await copyFile(from, to);
    else throw new Error(`Unsupported Skill entry: ${entry.name}`);
  }
}

export async function deploySkill(skillDirectory, skillsRootDirectory, options = {}) {
  check(typeof skillDirectory === 'string' && typeof skillsRootDirectory === 'string', 'SKILL_DIR and SKILLS_ROOT are required');
  const source = await realpath(path.resolve(skillDirectory));
  check((await lstat(source)).isDirectory(), 'SKILL_DIR must be a directory');
  const name = path.basename(source);
  check(/^[a-z0-9][a-z0-9-]{0,63}$/.test(name), 'Skill directory name is invalid');
  check((await lstat(path.join(source, 'SKILL.md'))).isFile(), 'SKILL_DIR has no SKILL.md');
  if (options.validateRelease !== false) await validateRelease(source, { full: true });
  await mkdir(path.resolve(skillsRootDirectory), { recursive: true });
  const root = await realpath(path.resolve(skillsRootDirectory));
  const destination = path.join(root, name);
  check(source !== root && !inside(root, source), 'Deployment source must be outside the skills root');
  check(source !== destination && !inside(source, destination), 'Source and destination must differ');
  const requestedBackupRoot = path.resolve(options.backupRoot ?? path.join(path.dirname(root), `${path.basename(root)}-backups`));
  check(requestedBackupRoot !== root && !inside(root, requestedBackupRoot), 'Backup root must be outside the skills root');
  await mkdir(requestedBackupRoot, { recursive: true });
  const backupRoot = await realpath(requestedBackupRoot);
  check(backupRoot !== root && !inside(root, backupRoot), 'Resolved backup root must be outside the skills root');
  check(backupRoot !== source && !inside(source, backupRoot) && !inside(backupRoot, source), 'Backup root and deployment source must not overlap');
  const staging = path.join(root, `.${name}.install-${randomUUID()}`);
  const rollback = path.join(root, `.${name}.rollback-${randomUUID()}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupRoot, `${name}.backup-${stamp}-${randomUUID()}`);
  const backupStaging = path.join(backupRoot, `.${name}.backup-${randomUUID()}`);
  let previousMoved = false;
  let candidateInstalled = false;
  let permanentBackupCreated = false;
  try {
    await copyTree(source, staging);
    const sourceInventory = await inventory(source);
    check(JSON.stringify(sourceInventory) === JSON.stringify(await inventory(staging)), 'Staged Skill inventory differs from source');
    try {
      const info = await lstat(destination);
      check(info.isDirectory() && !info.isSymbolicLink(), 'Existing destination is not a regular directory');
      const previousInventory = await inventory(destination);
      await copyTree(destination, backupStaging);
      check(JSON.stringify(previousInventory) === JSON.stringify(await inventory(backupStaging)), 'Permanent backup inventory differs from installed Skill');
      await rename(backupStaging, backup);
      permanentBackupCreated = true;
      await rename(destination, rollback);
      previousMoved = true;
      check(JSON.stringify(previousInventory) === JSON.stringify(await inventory(rollback)), 'Rollback slot inventory differs from installed Skill');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, destination);
    candidateInstalled = true;
    if (typeof options.afterCandidateInstalled === 'function') await options.afterCandidateInstalled(destination);
    check(JSON.stringify(sourceInventory) === JSON.stringify(await inventory(destination)), 'Installed Skill inventory differs from source');
    if (previousMoved) await rm(rollback, { recursive: true, force: false });
    return {
      status: 'passed', name, installed: destination,
      backup: permanentBackupCreated ? backup : null, backupRoot,
      files: Object.keys(await inventory(destination)).length,
    };
  } catch (error) {
    if (inside(root, staging)) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (inside(backupRoot, backupStaging)) await rm(backupStaging, { recursive: true, force: true }).catch(() => {});
    if (candidateInstalled && inside(root, destination)) await rm(destination, { recursive: true, force: true }).catch(() => {});
    if (previousMoved) {
      try { await rename(rollback, destination); }
      catch (restoreError) { error.cause = restoreError; }
    }
    throw error;
  }
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length < 4 || process.argv.length > 5) throw new Error('Usage: node deploy-skill.mjs SKILL_DIR SKILLS_ROOT [BACKUP_ROOT]');
  const options = process.argv[4] ? { backupRoot: process.argv[4] } : {};
  process.stdout.write(`${JSON.stringify(await deploySkill(process.argv[2], process.argv[3], options))}\n`);
}
