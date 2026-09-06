// Portable deployment of the three sibling Skills; local backups never enter releases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultSkillsDir, isMain } from '../../tiktok-seed-discovery/scripts/runtime/environment.mjs';

export const SKILL_NAMES = ['tiktok-seed-discovery', 'tiktok-seed-expansion', 'tiktok-discovery-retrospective'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export function inside(root, child) { const r = path.relative(root, child); return !!r && !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep); }
export async function inventory(root, current = root) {
  const details = await fs.lstat(current);
  if (!details.isDirectory() || details.isSymbolicLink()) throw Error('Unsafe inventory directory: ' + current);
  const files = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw Error('SYMLINK_NOT_SUPPORTED: ' + full);
    if (entry.isDirectory()) files.push(...await inventory(root, full));
    else if (entry.isFile()) { const bytes = await fs.readFile(full); files.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) }); }
    else throw Error('UNSUPPORTED_FILE_TYPE: ' + full);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function verifyPackage(sourceRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
  const actual = (await inventory(sourceRoot)).filter(f => f.path !== 'manifest.json');
  if (!Array.isArray(manifest.files) || !same(actual, manifest.files)) throw Error('PACKAGE_HASH_MISMATCH');
  return manifest;
}
async function withLock(target, body) {
  await fs.mkdir(target, { recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink()) throw Error('Unsafe Skills directory');
  const lockFile = path.join(target, '.tiktok-install.lock');
  let lock;
  try { lock = await fs.open(lockFile, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw Error('INSTALL_LOCKED: inspect the existing installer; do not delete an active lock'); throw e; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await body(); }
  finally { await lock.close(); await fs.unlink(lockFile); }
}
async function auditDirectory(target, id) {
  const base = path.join(target, '.tiktok-skill-installations');
  await fs.mkdir(base, { recursive: true });
  if ((await fs.lstat(base)).isSymbolicLink()) throw Error('Unsafe installation audit directory');
  const audit = path.join(base, id);
  await fs.mkdir(audit); return audit;
}
const newId = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
export async function installSkills({ skillsDir = defaultSkillsDir(), sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), dryRun = false, requireManifest = false } = {}) {
  const target = path.resolve(skillsDir), source = path.resolve(sourceRoot);
  if (target === source || inside(source, target) || inside(target, source)) throw Error('INSTALL_TARGET_OVERLAPS_PACKAGE');
  const manifest = await exists(path.join(source, 'manifest.json')) ? await verifyPackage(source) : null;
  if (requireManifest && !manifest) throw Error('VALIDATED_PACKAGE_REQUIRED: build a release first');
  const operation = async () => {
    const plan = [];
    for (const name of SKILL_NAMES) {
      const from = path.join(source, 'skills', name), destination = path.join(target, name);
      if (!await exists(path.join(from, 'SKILL.md'))) throw Error('BUNDLED_SKILL_MISSING: ' + name);
      const files = await inventory(from), previousFiles = await exists(destination) ? await inventory(destination) : null;
      const prefix = 'skills/' + name + '/';
      if (manifest && !same(files, manifest.files.filter(f => f.path.startsWith(prefix)).map(f => ({ path: f.path.slice(prefix.length), bytes: f.bytes, sha256: f.sha256 })))) throw Error('SOURCE_CHANGED_SINCE_PACKAGE_CHECK: ' + name);
      plan.push({ name, source: from, destination, action: same(previousFiles, files) ? 'unchanged' : previousFiles ? 'backup_and_replace' : 'install', files, previousFiles });
    }
    const result = { schemaVersion: 'tiktok-skills-install-2.1.0', installId: newId(), createdAt: new Date().toISOString(), sourceRoot: source, skillsDir: target, packageVersion: manifest?.packageVersion ?? null, packageVerified: !!manifest, dryRun, status: dryRun ? 'plan_only' : 'installing', skills: plan, backups: [] };
    if (dryRun) return result;
    const auditRoot = await auditDirectory(target, result.installId);
    result.auditFile = path.join(auditRoot, 'manifest.json');
    const persist = () => fs.writeFile(result.auditFile, JSON.stringify(result, null, 2) + '\n');
    await persist();
    try {
      // Stage and verify every changed Skill before replacing any live directory.
      for (const step of plan.filter(s => s.action !== 'unchanged')) {
        await fs.cp(step.source, path.join(auditRoot, 'staged-' + step.name), { recursive: true, force: false, errorOnExist: true });
        if (!same(await inventory(path.join(auditRoot, 'staged-' + step.name)), step.files)) throw Error('STAGING_HASH_MISMATCH: ' + step.name);
      }
      for (const step of plan) {
        if (step.action === 'unchanged') { step.result = 'unchanged'; continue; }
        step.result = 'replacing'; await persist();
        if (step.previousFiles) {
          const backup = path.join(auditRoot, 'backup-' + step.name);
          await fs.rename(step.destination, backup);
          step.backedUp = true; result.backups.push({ name: step.name, path: backup }); await persist();
          if (!same(await inventory(backup), step.previousFiles)) throw Error('DESTINATION_CHANGED_DURING_INSTALL: ' + step.name);
        }
        await fs.rename(path.join(auditRoot, 'staged-' + step.name), step.destination);
        step.applied = true; await persist();
        if (!same(await inventory(step.destination), step.files)) throw Error('INSTALL_HASH_MISMATCH: ' + step.name);
        step.result = 'installed_verified'; await persist();
      }
      result.status = 'installed_verified'; await persist(); return result;
    } catch (error) {
      // Preserve failed replacements and restore the whole group, not only the last Skill.
      const recoveryErrors = [];
      for (const step of [...plan].reverse()) {
        try {
          if (step.applied && await exists(step.destination)) await fs.rename(step.destination, path.join(auditRoot, 'failed-' + step.name));
          if (step.backedUp) await fs.rename(path.join(auditRoot, 'backup-' + step.name), step.destination);
          if (step.applied || step.backedUp) step.result = 'rolled_back';
        } catch (e) { recoveryErrors.push({ name: step.name, error: e.message }); }
      }
      result.status = recoveryErrors.length ? 'recovery_required' : 'rolled_back_after_failure';
      result.error = error.message; result.recoveryErrors = recoveryErrors; await persist();
      throw Error(error.message + '; audit: ' + result.auditFile);
    }
  };
  return dryRun ? operation() : withLock(target, operation);
}
export async function restoreInstallation({ skillsDir = defaultSkillsDir(), installId } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}T[\dTZ-]+-[a-f0-9]{8}$/.test(installId ?? '')) throw Error('Invalid installId');
  const target = path.resolve(skillsDir);
  return withLock(target, async () => {
    const origin = path.join(target, '.tiktok-skill-installations', installId);
    if ((await fs.lstat(origin)).isSymbolicLink()) throw Error('Unsafe rollback source');
    const previous = JSON.parse(await fs.readFile(path.join(origin, 'manifest.json'), 'utf8'));
    if (previous.schemaVersion !== 'tiktok-skills-install-2.1.0' || previous.status !== 'installed_verified' || previous.skillsDir !== target || !same(previous.skills.map(s => s.name), SKILL_NAMES)) throw Error('Unsupported or mismatched rollback receipt');
    // Fail before changes if any installed code/doc or backup changed after publication.
    for (const step of previous.skills) {
      if (!same(await inventory(path.join(target, step.name)), step.files)) throw Error('INSTALLED_FILES_CHANGED: ' + step.name);
      if (step.action !== 'unchanged' && step.previousFiles && !same(await inventory(path.join(origin, 'backup-' + step.name)), step.previousFiles)) throw Error('BACKUP_HASH_MISMATCH: ' + step.name);
    }
    const auditRoot = await auditDirectory(target, newId()), completed = [];
    const receipt = { type: 'rollback', originInstallId: installId, status: 'restoring', restored: [], auditRoot };
    const persist = () => fs.writeFile(path.join(auditRoot, 'rollback.json'), JSON.stringify(receipt, null, 2) + '\n');
    await persist();
    try {
      for (const step of previous.skills.filter(s => s.action !== 'unchanged')) {
        const staged = path.join(auditRoot, 'staged-' + step.name);
        if (step.previousFiles) { await fs.cp(path.join(origin, 'backup-' + step.name), staged, { recursive: true }); if (!same(await inventory(staged), step.previousFiles)) throw Error('ROLLBACK_STAGE_MISMATCH'); }
      }
      for (const step of previous.skills.filter(s => s.action !== 'unchanged')) {
        const destination = path.join(target, step.name);
        await fs.rename(destination, path.join(auditRoot, 'before-' + step.name));
        completed.push({ step, restored: false });
        if (step.previousFiles) { await fs.rename(path.join(auditRoot, 'staged-' + step.name), destination); completed.at(-1).restored = true; }
        receipt.restored.push(step.name); await persist();
      }
      receipt.status = 'restored_verified';
      for (const { step } of completed) if (step.previousFiles && !same(await inventory(path.join(target, step.name)), step.previousFiles)) throw Error('ROLLBACK_HASH_MISMATCH');
      await persist(); return receipt;
    } catch (error) {
      const recoveryErrors = [];
      for (const { step, restored } of completed.reverse()) {
        try {
          if (restored) await fs.rename(path.join(target, step.name), path.join(auditRoot, 'failed-' + step.name));
          await fs.rename(path.join(auditRoot, 'before-' + step.name), path.join(target, step.name));
        } catch (e) { recoveryErrors.push({ name: step.name, error: e.message }); }
      }
      receipt.status = recoveryErrors.length ? 'recovery_required' : 'rollback_failed_original_preserved';
      receipt.error = error.message; receipt.recoveryErrors = recoveryErrors; await persist(); throw Error(error.message + '; audit: ' + auditRoot);
    }
  });
}
export async function cli(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22+ required for this Skill bundle');
  let skillsDir, sourceRoot, installId, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (['--skills-dir', '--source', '--rollback'].includes(argv[i]) && argv[i + 1]) {
      const flag = argv[i], value = argv[++i];
      if (flag === '--skills-dir') skillsDir = value;
      else if (flag === '--source') sourceRoot = value;
      else installId = value;
    } else throw Error('Usage: install.mjs [--source <release>] [--skills-dir <dir>] [--dry-run] | --rollback <installId> [--skills-dir <dir>]');
  }
  if (installId && (sourceRoot || dryRun)) throw Error('Rollback does not accept source or dry-run');
  const result = installId ? await restoreInstallation({ skillsDir, installId }) : await installSkills({ skillsDir, sourceRoot, dryRun, requireManifest: true });
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (isMain(import.meta.url)) cli().catch(error => { console.error(JSON.stringify({ status: 'deployment_error', error: error.message })); process.exitCode = 1; });
