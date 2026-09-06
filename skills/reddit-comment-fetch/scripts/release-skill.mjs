#!/usr/bin/env node
/** Pure-Node release orchestration: tests -> validation -> exact gate -> ZIP + SHA sidecar. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSkill } from './package-skill.mjs';
import { validateRelease } from './validate-release.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const portable = (root, file) => path.relative(root, file).split(path.sep).join('/');
const isInside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function canonicalTarget(file) {
  const resolved = path.resolve(file);
  let ancestor = path.dirname(resolved);
  const missing = [path.basename(resolved)];
  while (true) {
    try { return path.join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      check(parent !== ancestor, `Cannot resolve an existing output ancestor: ${resolved}`);
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
const identity = info => ({ dev: info.dev, ino: info.ino });
const sameIdentity = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
async function removeOwned(file, ownedIdentity) {
  if (!ownedIdentity) return;
  let current;
  try { current = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return; else throw error; }
  if (current.isFile() && !current.isSymbolicLink() && sameIdentity(identity(current), ownedIdentity)) {
    await rm(file, { force: false });
  }
}
async function writeOwned(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  let handle = null;
  let ownedIdentity = null;
  try {
    handle = await open(file, 'wx+');
    ownedIdentity = identity(await handle.stat());
    await handle.writeFile(bytes);
    await handle.sync();
    const reread = Buffer.alloc(bytes.length);
    let read = 0;
    while (read < reread.length) {
      const result = await handle.read(reread, read, reread.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const extra = await handle.read(trailing, 0, 1, bytes.length);
    check(read === bytes.length && extra.bytesRead === 0 && reread.equals(bytes), `Output changed while being written: ${file}`);
    await handle.close();
    handle = null;
    return ownedIdentity;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try { await removeOwned(file, ownedIdentity); }
    catch (cleanupError) { error.cause = cleanupError; }
    throw error;
  }
}
const SUITES = Object.freeze([
  ['coreBehavior', 'scripts/verify-pack.mjs', root => [path.join(root, 'assets', 'reddit-comment-tree-pack', 'collect.mjs')]],
  ['pausedFinalization', 'scripts/verify-paused.mjs', () => []],
  ['postRunReview', 'scripts/verify-review.mjs', () => []],
  ['releaseCleanliness', 'scripts/verify-release.mjs', () => []],
  ['portablePackageAndDeploy', 'scripts/verify-portability.mjs', () => []],
]);

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function walk(root, directory = root, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    check(!info.isSymbolicLink(), `Release source contains a symlink: ${portable(root, absolute)}`);
    if (info.isDirectory()) await walk(root, absolute, result);
    else if (info.isFile() && portable(root, absolute) !== 'validation.json') result.push(absolute);
    else if (!info.isFile()) throw new Error(`Unsupported release entry: ${portable(root, absolute)}`);
  }
  return result;
}

async function atomicText(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx' });
  try {
    await rename(temporary, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await rm(file, { force: true });
    await rename(temporary, file);
  }
}

async function runSuite(root, key, relative, args) {
  const script = path.join(root, ...relative.split('/'));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current, bytes) => {
      const next = current + bytes.toString('utf8');
      check(Buffer.byteLength(next, 'utf8') <= 8_000_000, `Release suite output is too large: ${key}`);
      return next;
    };
    child.stdout.on('data', bytes => { try { stdout = append(stdout, bytes); } catch (error) { child.kill(); reject(error); } });
    child.stderr.on('data', bytes => { try { stderr = append(stderr, bytes); } catch (error) { child.kill(); reject(error); } });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Release suite failed: ${key}\n${stdout}${stderr}`));
      const matches = [...`${stdout}\n${stderr}`.matchAll(/^# tests (\d+)\s*$/gm)];
      const tests = Number(matches.at(-1)?.[1]);
      if (!Number.isSafeInteger(tests) || tests < 1) return reject(new Error(`Release suite did not report a TAP test count: ${key}`));
      resolve({ key, status: 'passed', tests, pass: tests, fail: 0 });
    });
  });
}

function bundleVersion(skillText) {
  const version = skillText.match(/^---[\s\S]*?metadata:\s*\n\s+version:\s*["']?([^"'\s]+)["']?[\s\S]*?---/m)?.[1];
  check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''), 'SKILL.md has no valid metadata.version');
  return version;
}

async function buildValidation(root, suiteResults) {
  const version = bundleVersion(await readFile(path.join(root, 'SKILL.md'), 'utf8'));
  const pack = JSON.parse(await readFile(path.join(root, 'assets', 'reddit-comment-tree-pack', 'pack.json'), 'utf8'));
  check(pack.version === version, 'Skill and Pack versions differ');
  const records = [];
  for (const file of (await walk(root)).sort((a, b) => lexical(portable(root, a), portable(root, b)))) {
    const bytes = await readFile(file);
    records.push({ path: portable(root, file), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const collector = records.find(record => record.path === 'assets/reddit-comment-tree-pack/collect.mjs');
  check(collector, 'Collector is missing from release inventory');
  const matrix = {
    windows: { status: 'not_tested', node: null },
    linux: { status: 'not_tested', node: null },
    macos: { status: 'not_tested', node: null },
  };
  const platform = ({ win32: 'windows', linux: 'linux', darwin: 'macos' })[process.platform];
  if (platform) matrix[platform] = { status: 'tested', node: process.versions.node };
  const checks = Object.fromEntries(suiteResults.map(result => [result.key, { status: result.status, tests: result.tests, pass: result.pass, fail: result.fail }]));
  checks.packageRoundTrip = { status: 'passed_by_portability_suite', exactArchiveReceipt: 'external sidecar' };
  checks.installRoundTrip = { status: 'passed_by_portability_suite', exactInstallReceipt: 'deployment result' };
  return {
    schema: 1,
    bundleVersion: version,
    releaseStatus: 'passed',
    scope: 'Portable Skill and Pack release validation only; no task, account, Profile, post, comment or business-run evidence is stored here.',
    checks,
    sourceBasis: {
      comments: 'https://www.reddit.com/dev/api/#GET_comments_{article}',
      morechildren: 'https://www.reddit.com/dev/api/#GET_api_morechildren',
      note: 'Official endpoint semantics only; live access is not inferred.',
    },
    portability: {
      design: 'Node ESM and built-in modules; path-safe runtime inputs; no shell, launcher path or operating-system command dependency in the collector.',
      matrix,
      claim: 'A platform is marked tested only when this exact release is executed there; platform-neutral design is not reported as live validation.',
    },
    artifacts: { collectorSha256: collector.sha256, filesExcludingValidation: records },
    limits: [
      'Target Task Master capabilities must be checked on each device.',
      'Offline tests do not prove Reddit access or live response stability.',
      'No fixed throughput, platform quota or historical absolute completeness is promised.',
      'State schema and method revision must both pass explicit compatibility checks before resume.',
    ],
  };
}

export async function releaseSkill(skillDirectory, newZipFile, sidecarFile = `${newZipFile}.sha256.txt`) {
  check(typeof skillDirectory === 'string' && typeof newZipFile === 'string' && typeof sidecarFile === 'string', 'SKILL_DIR, NEW_ZIP and SHA_SIDECAR must be paths');
  const root = await realpath(path.resolve(skillDirectory));
  const zip = await canonicalTarget(newZipFile);
  const sidecar = await canonicalTarget(sidecarFile);
  check(zip !== sidecar, 'ZIP and SHA sidecar paths must differ');
  check(zip !== root && !isInside(root, zip), 'ZIP destination must be outside the Skill source');
  check(sidecar !== root && !isInside(root, sidecar), 'SHA sidecar destination must be outside the Skill source');
  check(!(await exists(zip)) && !(await exists(sidecar)), 'ZIP and SHA sidecar destinations must not exist');
  const validationPath = path.join(root, 'validation.json');
  const previousValidation = await readFile(validationPath).catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
  let archiveCreated = false;
  let sidecarCreated = false;
  let archiveIdentity = null;
  let sidecarIdentity = null;
  try {
    const results = [];
    for (const [key, relative, args] of SUITES) results.push(await runSuite(root, key, relative, args(root)));
    await atomicText(validationPath, json(await buildValidation(root, results)));
    const exactGate = await validateRelease(root, { full: true });
    const archive = await packageSkill(root, zip);
    archiveCreated = true;
    archiveIdentity = archive.outputIdentity;
    sidecarIdentity = await writeOwned(sidecar, Buffer.from(`${archive.sha256}  ${path.basename(zip)}\n`, 'utf8'));
    sidecarCreated = true;
    return { status: 'passed', version: exactGate.version, suites: results, exactGate, archive: { path: zip, files: archive.files, bytes: archive.bytes, sha256: archive.sha256 }, sidecar };
  } catch (error) {
    if (sidecarCreated) await removeOwned(sidecar, sidecarIdentity).catch(cleanupError => { error.cause ??= cleanupError; });
    if (archiveCreated) await removeOwned(zip, archiveIdentity).catch(cleanupError => { error.cause ??= cleanupError; });
    if (previousValidation === null) await rm(validationPath, { force: true }).catch(() => {});
    else await atomicText(validationPath, previousValidation.toString('utf8')).catch(restoreError => { error.cause = restoreError; });
    throw error;
  }
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length < 4 || process.argv.length > 5) throw new Error('Usage: node release-skill.mjs SKILL_DIR NEW_ZIP [SHA_SIDECAR]');
  const result = await releaseSkill(process.argv[2], process.argv[3], process.argv[4] ?? `${process.argv[3]}.sha256.txt`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
